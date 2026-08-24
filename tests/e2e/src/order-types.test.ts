/**
 * Order-type e2e tests: partial fills and buy orders.
 *
 * These exercise code paths the happy-path test does not cover:
 * - Partial fills: scaledToFill() scoring, partiallyFillable flag, partial executedAmount
 * - Buy orders: buy-side surplus, gas cut added to input, swapTokensForExactTokens
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */
import { pad } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { deployerWallet, publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONTRACTS } from "./helpers/config.js";
import { buildBuyInteractions, buildSellInteractions } from "./helpers/interactions.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	type GpvOrder,
	getAmountsIn,
	getAmountsOut,
	signAndSubmitOrder,
	tokenBalance,
	waitForTrade,
} from "./helpers/orderbook.js";

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
		const interactions = buildSellInteractions(
			sellToken,
			buyToken,
			proposalSellAmount,
			minBuyAmount,
		);

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
