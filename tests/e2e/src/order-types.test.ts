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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { submitProposalUntilTrade, waitForProposalStatus } from "./helpers/byos.js";
import { publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONTRACTS } from "./helpers/config.js";
import { buildBuyInteractions, buildSellInteractions } from "./helpers/interactions.js";
import {
	cancelOrders,
	type GpvOrder,
	getAmountsIn,
	getAmountsOut,
	signAndSubmitOrder,
	tokenBalance,
} from "./helpers/orderbook.js";

import { assertE2ePrerequisites } from "./helpers/prerequisites.js";
import { createTimingLog } from "./helpers/timing.js";

// --- Test lifecycle ---

const submittedOrders: string[] = [];
afterEach(async () => {
	const timing = createTimingLog("order-types cleanup");
	await cancelOrders(traderWallet, submittedOrders.splice(0));
	timing("remaining partial orders cancelled");
});

beforeAll(async () => {
	const timing = createTimingLog("order-types setup");
	await assertE2ePrerequisites();
	timing("seeded prerequisites verified; setup complete");
});

// No snapshot revert — chain state persists across test files so the
// BYOS balance cache stays warm for subsequent files using the same sub-solver.

// --- Tests ---

describe("order types", () => {
	it("partial fill sell order: 50% fill of USDC → WETH", { timeout: 180_000 }, async () => {
		const timing = createTimingLog("partial sell");
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const orderSellAmount = 2_000_000_000n; // 2000 USDC (full order)
		const proposalSellAmount = 1_000_000_000n; // 1000 USDC (50% fill)

		// 1. Get Uniswap quote for the partial amount
		const amounts = await getAmountsOut(publicClient, proposalSellAmount, [sellToken, buyToken]);
		timing("Uniswap quote fetched");
		const expectedBuyAmount = amounts[1];
		if (expectedBuyAmount === undefined) throw new Error("missing sell quote");
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
		submittedOrders.push(orderUid);
		timing(`order signed and accepted: ${orderUid}`);
		expect(orderUid).toBeDefined();

		// 4. Record USDC balance before settlement
		const usdcBefore = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);
		const wethBefore = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		timing("pre-settlement balance read");

		// 5. Build interactions for 50% fill and follow auctions until settlement
		const interactions = buildSellInteractions(
			sellToken,
			buyToken,
			proposalSellAmount,
			minBuyAmount,
		);

		const { id: proposalId } = await submitProposalUntilTrade(
			{
				walletClient: subSolverWallet,
				orderUid,
				sellToken,
				buyToken,
				sellAmount: proposalSellAmount,
				minBuyAmount,
				quoteBuyAmount: expectedBuyAmount,
				interactions,
			},
			90_000,
			timing,
		);
		timing("settlement helper returned (including cleanup)");
		expect(proposalId).toBeGreaterThan(0);

		// 6. Verify trader's USDC decreased by ~1000 (not 2000)
		const usdcAfter = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);
		const spent = usdcBefore - usdcAfter;
		expect(spent).toBeGreaterThan(0n);
		expect(spent).toBeLessThanOrEqual(proposalSellAmount);

		// 7. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(wethBalance).toBeGreaterThan(wethBefore);

		timing("post-settlement balance checks complete");

		// 8. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(
			subSolverWallet,
			proposalId,
			["settled", "settleFailed"],
			60_000,
		);
		expect(proposal.status).toBe("settled");
		timing("final proposal status checked; test complete");
	});

	it("buy order: WETH → USDC settles end-to-end", async () => {
		const timing = createTimingLog("buy");
		const sellToken = CONTRACTS.weth;
		const buyToken = CONTRACTS.usdc;
		const desiredBuyAmount = 500_000_000n; // 500 USDC

		// 1. Get Uniswap quote: how much WETH needed for 500 USDC
		const amounts = await getAmountsIn(publicClient, desiredBuyAmount, [sellToken, buyToken]);
		timing("Uniswap quote fetched");
		const requiredSellAmount = amounts[0];
		if (requiredSellAmount === undefined) throw new Error("missing buy quote");
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
		submittedOrders.push(orderUid);
		timing(`order signed and accepted: ${orderUid}`);
		expect(orderUid).toBeDefined();

		// 3. Build buy-order interactions (swapTokensForExactTokens)
		const interactions = buildBuyInteractions(
			sellToken,
			buyToken,
			desiredBuyAmount,
			requiredSellAmount,
		);

		// 4. Submit proposal: for buy orders, minBuyAmount = quoteBuyAmount = order.buyAmount
		const { id: proposalId } = await submitProposalUntilTrade(
			{
				walletClient: subSolverWallet,
				orderUid,
				sellToken,
				buyToken,
				sellAmount: requiredSellAmount,
				minBuyAmount: desiredBuyAmount,
				quoteBuyAmount: desiredBuyAmount,
				interactions,
			},
			90_000,
			timing,
		);
		timing("settlement helper returned (including cleanup)");
		expect(proposalId).toBeGreaterThan(0);

		// 5. Verify trader received USDC
		const usdcBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(usdcBalance).toBeGreaterThan(0n);

		timing("post-settlement balance checks complete");

		// 6. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
		timing("final proposal status checked; test complete");
	});
});
