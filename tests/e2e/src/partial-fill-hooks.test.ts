/**
 * Partial fill + HooksTrampoline e2e test.
 *
 * Exercises GPv2 pre/post hooks over two partial fills:
 * - Pre-hook: ERC-2612 permit on first fill only (grants VaultRelayer allowance
 *   without a prior approve — the permit is the only allowance source).
 * - Post-hook: benign WETH.symbol() call on every fill.
 *
 * The second fill reuses the remaining permit allowance from the first fill,
 * so no pre-hook is needed. This mirrors the Rust partial_fill_hooks.rs e2e test.
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */
import { HooksTrampolineAbi } from "@byos/common";
import type { Address } from "viem";
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	encodeFunctionData,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import {
	appDataHash,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	type GpvOrder,
	getAmountsOut,
	registerAppData,
	signAndSubmitOrder,
	signEip2612Permit,
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
	// Setup sub-solver
	await depositToEscrow(
		subSolverWallet,
		publicClient,
		ACCOUNTS.subSolver.address,
		2_000_000_000_000_000_000n, // 2 ETH
	);
	await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);

	// Fund trader with USDC — intentionally NO approveVaultRelayer call.
	// The ERC-2612 permit in the pre-hook is the only allowance source.
	await fundToken(
		deployerWallet,
		publicClient,
		CONTRACTS.usdc,
		ACCOUNTS.trader.address,
		5_000_000_000n, // 5000 USDC
	);
});

// No snapshot revert — chain state persists across test files so the
// BYOS balance cache stays warm for subsequent files using the same sub-solver.

// --- Helpers ---

function buildSellInteractions(
	sellToken: Address,
	buyToken: Address,
	sellAmount: bigint,
	minBuyAmount: bigint,
): { target: Address; value: bigint; callData: `0x${string}` }[] {
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

// --- Tests ---

describe("partial fill with hooks", () => {
	it("ERC-2612 permit pre-hook on first fill, post-hook on every fill", {
		timeout: 400_000,
	}, async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		// Full order: 2000 USDC (two partial fills will cover 1000 + 600 = 1600 USDC)
		const orderSellAmount = 2_000_000_000n;
		const fill1Amount = 1_000_000_000n; // first fill: 1000 USDC
		const fill2Amount = 600_000_000n; // second fill: 600 USDC

		// 1. Sign ERC-2612 permit for the full order sell amount.
		//    This is the ONLY source of VaultRelayer allowance — no approve() is called.
		const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
		const permitCalldata = await signEip2612Permit(
			traderWallet,
			publicClient,
			sellToken,
			"USD Coin",
			"2",
			CONTRACTS.vaultRelayer,
			orderSellAmount,
			permitDeadline,
		);

		// 2. Build HooksTrampoline pre-hook: execute the permit via the trampoline.
		//    The trampoline enforces msg.sender == settlement before running hooks.
		const preHookCalldata = encodeFunctionData({
			abi: HooksTrampolineAbi,
			functionName: "execute",
			args: [
				[
					{
						target: sellToken,
						callData: permitCalldata,
						gasLimit: 100_000n,
					},
				],
			],
		});

		// 3. Build HooksTrampoline post-hook: benign WETH.symbol() call.
		//    Exercises the post-interaction slot without side effects.
		const postHookCalldata = encodeFunctionData({
			abi: HooksTrampolineAbi,
			functionName: "execute",
			args: [
				[
					{
						target: buyToken,
						// symbol() selector: keccak256("symbol()")[0:4] = 0x95d89b41
						callData: "0x95d89b41",
						gasLimit: 50_000n,
					},
				],
			],
		});

		// 4. Build and register the CoW appData JSON with hooks.
		//    The pre-hook runs before sell token transfer (grants allowance).
		//    The post-hook runs after settlement (benign read).
		const hooksDoc = JSON.stringify({
			metadata: {
				hooks: {
					pre: [
						{
							target: CONTRACTS.hooksTrampoline,
							callData: preHookCalldata,
							gasLimit: "200000",
						},
					],
					post: [
						{
							target: CONTRACTS.hooksTrampoline,
							callData: postHookCalldata,
							gasLimit: "100000",
						},
					],
				},
			},
		});
		const hooksAppDataHash = appDataHash(hooksDoc);
		await registerAppData(hooksAppDataHash, hooksDoc);

		// 5. Get quotes and compute order buy amount limit.
		const [, expectedFill1Buy] = await getAmountsOut(publicClient, fill1Amount, [
			sellToken,
			buyToken,
		]);
		const [, expectedFill2Buy] = await getAmountsOut(publicClient, fill2Amount, [
			sellToken,
			buyToken,
		]);
		// Limit price on the order: scale fill1 min buy to the full order amount
		const minFill1Buy = (expectedFill1Buy * 95n) / 100n;
		const orderBuyAmount = (minFill1Buy * orderSellAmount) / fill1Amount;

		// 6. Submit the partially fillable order with hooks in appData.
		//    No VaultRelayer approve — the permit pre-hook handles it on first fill.
		const validTo = Math.floor(Date.now() / 1000) + 600;
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: ACCOUNTS.trader.address,
			sellAmount: orderSellAmount,
			buyAmount: orderBuyAmount,
			validTo,
			appData: hooksAppDataHash,
			feeAmount: 0n,
			kind: "sell",
			partiallyFillable: true,
			sellTokenBalance: "erc20",
			buyTokenBalance: "erc20",
		};
		const orderUid = await signAndSubmitOrder(traderWallet, order);
		expect(orderUid).toBeDefined();

		// Record balances before any settlement
		const usdcBefore = await getUsdcBalance();
		const wethBefore = await getWethBalance();

		// --- Fill 1: 1000 USDC ---
		// Submit proposal and wait for settlement.
		// The autopilot picks up the order; the solve response will include the
		// pre-hook (permit) in pre_interactions and post-hook in post_interactions.
		const fill1Interactions = buildSellInteractions(sellToken, buyToken, fill1Amount, minFill1Buy);
		const { id: proposalId1 } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount: fill1Amount,
			minBuyAmount: minFill1Buy,
			quoteBuyAmount: expectedFill1Buy,
			interactions: fill1Interactions,
		});
		expect(proposalId1).toBeGreaterThan(0);

		// Partially fillable orders are classified as "limit" by the autopilot
		// and may take more auction cycles — use an extended timeout.
		await waitForTrade(orderUid, publicClient, 160_000, 1);

		// Verify first fill happened: trader spent ~1000 USDC
		const usdcAfterFill1 = await getUsdcBalance();
		const spentFill1 = usdcBefore - usdcAfterFill1;
		expect(spentFill1).toBeGreaterThan(0n);
		expect(spentFill1).toBeLessThanOrEqual(fill1Amount);

		// --- Fill 2: 600 USDC ---
		// No permit needed: the first fill used 1000 USDC of the 2000 USDC allowance,
		// so 1000 USDC remains — enough to cover this 600 USDC fill.
		const minFill2Buy = (expectedFill2Buy * 95n) / 100n;
		const fill2Interactions = buildSellInteractions(sellToken, buyToken, fill2Amount, minFill2Buy);
		const { id: proposalId2 } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount: fill2Amount,
			minBuyAmount: minFill2Buy,
			quoteBuyAmount: expectedFill2Buy,
			interactions: fill2Interactions,
		});
		expect(proposalId2).toBeGreaterThan(0);

		await waitForTrade(orderUid, publicClient, 160_000, 2);

		// --- Final assertions ---

		// Trader spent ~1600 USDC total (1000 + 600)
		const usdcAfterFill2 = await getUsdcBalance();
		const totalSpent = usdcBefore - usdcAfterFill2;
		expect(totalSpent).toBeGreaterThan(fill1Amount); // more than fill1
		expect(totalSpent).toBeLessThanOrEqual(fill1Amount + fill2Amount);

		// Trader received WETH from both fills
		const wethAfterFill2 = await getWethBalance();
		expect(wethAfterFill2).toBeGreaterThan(wethBefore);

		// Both proposals should have settled
		const result1 = await waitForProposalStatus(subSolverWallet, proposalId1, [
			"settled",
			"settleFailed",
		]);
		expect(result1.status).toBe("settled");

		const result2 = await waitForProposalStatus(subSolverWallet, proposalId2, [
			"settled",
			"settleFailed",
		]);
		expect(result2.status).toBe("settled");
	});
});

// --- Balance helpers ---

async function getUsdcBalance(): Promise<bigint> {
	const { erc20Abi } = await import("viem");
	return publicClient.readContract({
		address: CONTRACTS.usdc,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [ACCOUNTS.trader.address],
	});
}

async function getWethBalance(): Promise<bigint> {
	const { erc20Abi } = await import("viem");
	return publicClient.readContract({
		address: CONTRACTS.weth,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [ACCOUNTS.trader.address],
	});
}
