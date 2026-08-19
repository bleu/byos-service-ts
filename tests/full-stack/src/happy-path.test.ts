/**
 * Happy-path full-stack e2e test.
 *
 * Exercises the core round-trip: place a GPv2 order on the orderbook,
 * submit a BYOS proposal with Uniswap V2 interactions, wait for the
 * autopilot → driver → /solve → settlement → /notify cycle to complete.
 *
 * Requires the full e2e stack running (./scripts/e2e-stack.sh up -d --build --wait).
 */
import type { ContractInteraction } from "@byos/common";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, encodeFunctionData, http, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { revertSnapshot, takeSnapshot } from "./helpers/chain.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import {
	approveVaultRelayer,
	fundToken,
	type GpvOrder,
	getAmountsOut,
	signAndSubmitOrder,
	tokenBalance,
	waitForOrderExecution,
} from "./helpers/orderbook.js";

// --- Clients ---

const publicClient = createPublicClient({
	chain: foundry,
	transport: http(CONFIG.rpcUrl),
});

const traderAccount = privateKeyToAccount(ACCOUNTS.trader.key);
const traderWallet = createWalletClient({
	account: traderAccount,
	chain: foundry,
	transport: http(CONFIG.rpcUrl),
});

const subSolverAccount = privateKeyToAccount(ACCOUNTS.subSolver.key);
const subSolverWallet = createWalletClient({
	account: subSolverAccount,
	chain: foundry,
	transport: http(CONFIG.rpcUrl),
});

// Account #0 is the deployer with pre-funded token balances
const deployerAccount = privateKeyToAccount(ACCOUNTS.baselineSolver.key);
const deployerWallet = createWalletClient({
	account: deployerAccount,
	chain: foundry,
	transport: http(CONFIG.rpcUrl),
});

// --- Test lifecycle ---

let snapshotId: Hex;

beforeAll(async () => {
	snapshotId = await takeSnapshot(publicClient);
});

afterAll(async () => {
	await revertSnapshot(publicClient, snapshotId);
});

// --- Helpers ---

/** Build Uniswap V2 swap interactions for the proposal. */
function buildUniswapInteractions(
	sellToken: Address,
	buyToken: Address,
	sellAmount: bigint,
	minBuyAmount: bigint,
): ContractInteraction[] {
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

	// 1. Approve the Uniswap router to spend sellToken
	const approveCalldata = encodeFunctionData({
		abi: [
			{
				type: "function",
				name: "approve",
				inputs: [
					{ type: "address", name: "spender" },
					{ type: "uint256", name: "amount" },
				],
				outputs: [{ type: "bool" }],
			},
		],
		functionName: "approve",
		args: [CONTRACTS.uniswapV2Router, sellAmount],
	});

	// 2. Swap via the router
	const swapCalldata = encodeFunctionData({
		abi: [
			{
				type: "function",
				name: "swapExactTokensForTokens",
				inputs: [
					{ type: "uint256", name: "amountIn" },
					{ type: "uint256", name: "amountOutMin" },
					{ type: "address[]", name: "path" },
					{ type: "address", name: "to" },
					{ type: "uint256", name: "deadline" },
				],
				outputs: [{ type: "uint256[]", name: "amounts" }],
			},
		],
		functionName: "swapExactTokensForTokens",
		args: [sellAmount, minBuyAmount, [sellToken, buyToken], CONTRACTS.gpv2Settlement, deadline],
	});

	return [
		{ target: sellToken, value: 0n, callData: approveCalldata },
		{ target: CONTRACTS.uniswapV2Router, value: 0n, callData: swapCalldata },
	];
}

// --- Tests ---

describe("happy path", () => {
	it("sell order: USDC → WETH settles end-to-end", async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const sellAmount = 1_000_000_000n; // 1000 USDC (6 decimals)

		// 1. Fund trader with USDC and approve VaultRelayer
		await fundToken(
			deployerWallet,
			publicClient,
			sellToken,
			ACCOUNTS.trader.address,
			sellAmount * 3n,
		);
		await approveVaultRelayer(traderWallet, publicClient, sellToken);

		// 2. Get Uniswap V2 quote
		const amounts = await getAmountsOut(publicClient, sellAmount, [sellToken, buyToken]);
		const expectedBuyAmount = amounts[1];
		// 5% slippage tolerance
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;

		// 3. Sign and submit GPv2 order to the orderbook
		const validTo = Math.floor(Date.now() / 1000) + 600; // 10 min
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: ACCOUNTS.trader.address,
			sellAmount,
			buyAmount: minBuyAmount,
			validTo,
			appData: pad("0x00", { size: 32 }),
			feeAmount: 0n,
			kind: "sell",
			partiallyFillable: false,
			sellTokenBalance: "erc20",
			buyTokenBalance: "erc20",
		};

		const orderUid = await signAndSubmitOrder(traderWallet, order);
		expect(orderUid).toBeDefined();
		expect(orderUid.length).toBeGreaterThan(10);

		// 4. Build proposal interactions (Uniswap V2 swap)
		const interactions = buildUniswapInteractions(sellToken, buyToken, sellAmount, minBuyAmount);

		// 5. Submit BYOS proposal
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount,
			minBuyAmount,
			quoteBuyAmount: expectedBuyAmount,
			interactions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// 6. Wait for the order to be fulfilled via the autopilot → driver → settlement cycle
		const result = await waitForOrderExecution(orderUid, publicClient);
		expect(result.status).toBe("fulfilled");

		// 7. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(wethBalance).toBeGreaterThan(0n);

		// 8. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
	});
});
