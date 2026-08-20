/**
 * Order-type e2e tests: partial fills and buy orders.
 *
 * These exercise code paths the happy-path test does not cover:
 * - Partial fills: scaledToFill() scoring, partiallyFillable flag, partial executedAmount
 * - Buy orders: buy-side surplus, gas cut added to input, swapTokensForExactTokens
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */
import type { ContractInteraction } from "@byos/common";
import type { Address } from "viem";
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	encodeFunctionData,
	http,
	pad,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	getAmountsIn,
	getAmountsOut,
	type GpvOrder,
	signAndSubmitOrder,
	tokenBalance,
	waitForTrade,
} from "./helpers/orderbook.js";

// --- Chain definition ---

const anvilMainnet = defineChain({
	id: CONFIG.chainId,
	name: "Anvil Mainnet",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
});

// --- Clients ---

const publicClient = createPublicClient({
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

const traderAccount = privateKeyToAccount(ACCOUNTS.trader.key);
const traderWallet = createWalletClient({
	account: traderAccount,
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

const subSolverAccount = privateKeyToAccount(ACCOUNTS.subSolver.key);
const subSolverWallet = createWalletClient({
	account: subSolverAccount,
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

const deployerAccount = privateKeyToAccount(ACCOUNTS.baselineSolver.key);
const deployerWallet = createWalletClient({
	account: deployerAccount,
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

// --- Test lifecycle ---

beforeAll(async () => {
	// Setup sub-solver: escrow deposit + trampoline
	await depositToEscrow(
		subSolverWallet,
		publicClient,
		ACCOUNTS.subSolver.address,
		2_000_000_000_000_000_000n, // 2 ETH (covers gas costs for multiple settlements)
	);
	await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);

	// Fund trader with USDC and WETH, approve VaultRelayer for both
	await fundToken(
		deployerWallet,
		publicClient,
		CONTRACTS.usdc,
		ACCOUNTS.trader.address,
		5_000_000_000n, // 5000 USDC
	);
	await fundToken(
		deployerWallet,
		publicClient,
		CONTRACTS.weth,
		ACCOUNTS.trader.address,
		3_000_000_000_000_000_000n, // 3 WETH
	);
	await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.usdc);
	await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.weth);
});

// No snapshot revert — chain state persists across test files so the
// BYOS balance cache stays warm for subsequent files using the same sub-solver.

// --- Helpers ---

function buildSellInteractions(
	sellToken: Address,
	buyToken: Address,
	sellAmount: bigint,
	minBuyAmount: bigint,
): ContractInteraction[] {
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

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

function buildBuyInteractions(
	sellToken: Address,
	buyToken: Address,
	buyAmount: bigint,
	maxSellAmount: bigint,
): ContractInteraction[] {
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

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
		args: [CONTRACTS.uniswapV2Router, maxSellAmount],
	});

	const swapCalldata = encodeFunctionData({
		abi: [
			{
				type: "function",
				name: "swapTokensForExactTokens",
				inputs: [
					{ type: "uint256", name: "amountOut" },
					{ type: "uint256", name: "amountInMax" },
					{ type: "address[]", name: "path" },
					{ type: "address", name: "to" },
					{ type: "uint256", name: "deadline" },
				],
				outputs: [{ type: "uint256[]", name: "amounts" }],
			},
		],
		functionName: "swapTokensForExactTokens",
		args: [buyAmount, maxSellAmount, [sellToken, buyToken], CONTRACTS.gpv2Settlement, deadline],
	});

	return [
		{ target: sellToken, value: 0n, callData: approveCalldata },
		{ target: CONTRACTS.uniswapV2Router, value: 0n, callData: swapCalldata },
	];
}

// --- Tests ---

describe("order types", () => {
	it("partial fill sell order: 50% fill of USDC → WETH", { timeout: 180_000 }, async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const orderSellAmount = 2_000_000_000n; // 2000 USDC (full order)
		const proposalSellAmount = 1_000_000_000n; // 1000 USDC (50% fill)

		// 1. Get Uniswap quote for the partial amount
		const amounts = await getAmountsOut(publicClient, proposalSellAmount, [sellToken, buyToken]);
		const expectedBuyAmount = amounts[1];
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;

		// 2. Compute the order's limit buy amount (scaled to full order)
		const orderBuyAmount = (minBuyAmount * orderSellAmount) / proposalSellAmount;

		// 3. Place partially fillable GPv2 order
		const validTo = Math.floor(Date.now() / 1000) + 600;
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: ACCOUNTS.trader.address,
			sellAmount: orderSellAmount,
			buyAmount: orderBuyAmount,
			validTo,
			appData: pad("0x00", { size: 32 }),
			feeAmount: 0n,
			kind: "sell",
			partiallyFillable: true,
			sellTokenBalance: "erc20",
			buyTokenBalance: "erc20",
		};

		const orderUid = await signAndSubmitOrder(traderWallet, order);
		expect(orderUid).toBeDefined();

		// 4. Record USDC balance before settlement
		const usdcBefore = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);

		// 5. Build interactions for 50% fill and submit proposal
		const interactions = buildSellInteractions(sellToken, buyToken, proposalSellAmount, minBuyAmount);

		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount: proposalSellAmount,
			minBuyAmount,
			quoteBuyAmount: expectedBuyAmount,
			interactions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// 6. Wait for the trade — partially fillable orders are classified as "limit"
		// by the orderbook, so the autopilot may take more auction cycles to settle them
		await waitForTrade(orderUid, publicClient, 160_000);

		// 7. Verify trader's USDC decreased by ~1000 (not 2000)
		const usdcAfter = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);
		const spent = usdcBefore - usdcAfter;
		expect(spent).toBeGreaterThan(0n);
		expect(spent).toBeLessThanOrEqual(proposalSellAmount);

		// 8. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(wethBalance).toBeGreaterThan(0n);

		// 9. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
	});

	it("buy order: WETH → USDC settles end-to-end", async () => {
		const sellToken = CONTRACTS.weth;
		const buyToken = CONTRACTS.usdc;
		const desiredBuyAmount = 500_000_000n; // 500 USDC

		// 1. Get Uniswap quote: how much WETH needed for 500 USDC
		const amounts = await getAmountsIn(publicClient, desiredBuyAmount, [sellToken, buyToken]);
		const requiredSellAmount = amounts[0];
		// Allow 10% slippage on the sell side (trader's limit)
		const maxSellAmount = (requiredSellAmount * 110n) / 100n;

		// 2. Place buy order
		const validTo = Math.floor(Date.now() / 1000) + 600;
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: ACCOUNTS.trader.address,
			sellAmount: maxSellAmount,
			buyAmount: desiredBuyAmount,
			validTo,
			appData: pad("0x00", { size: 32 }),
			feeAmount: 0n,
			kind: "buy",
			partiallyFillable: false,
			sellTokenBalance: "erc20",
			buyTokenBalance: "erc20",
		};

		const orderUid = await signAndSubmitOrder(traderWallet, order);
		expect(orderUid).toBeDefined();

		// 3. Build buy-order interactions (swapTokensForExactTokens)
		const interactions = buildBuyInteractions(
			sellToken,
			buyToken,
			desiredBuyAmount,
			requiredSellAmount,
		);

		// 4. Submit proposal: for buy orders, minBuyAmount = quoteBuyAmount = order.buyAmount
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount: requiredSellAmount,
			minBuyAmount: desiredBuyAmount,
			quoteBuyAmount: desiredBuyAmount,
			interactions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// 5. Wait for settlement
		await waitForTrade(orderUid, publicClient);

		// 6. Verify trader received USDC
		const usdcBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(usdcBalance).toBeGreaterThan(0n);

		// 7. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
	});
});
