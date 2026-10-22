/**
 * Partial fill + HooksTrampoline e2e test.
 *
 * Exercises GPv2 pre/post hooks on a partial fill:
 * - Pre-hook: ERC-2612 permit via HooksTrampoline (grants VaultRelayer allowance
 *   without a prior approve — the permit is the only allowance source).
 * - Post-hook: benign WETH.symbol() call.
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */
import { erc20Abi, parseAbi } from "viem";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { submitProposalUntilTrade, waitForProposalStatus } from "./helpers/byos.js";
import { publicClient, subSolverWallet } from "./helpers/clients.js";
import { CONTRACTS } from "./helpers/config.js";
import { E2E_FIXTURES, fixtureWallet, HOOK_TRADER } from "./helpers/fixtures.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	appDataHash,
	cancelOrders,
	type GpvOrder,
	getAmountsOut,
	registerAppData,
	signAndSubmitOrder,
	signEip2612Permit,
	tokenBalance,
} from "./helpers/orderbook.js";
import { assertE2ePrerequisites } from "./helpers/prerequisites.js";
import { createTimingLog } from "./helpers/timing.js";

const traderWallet = fixtureWallet(HOOK_TRADER);

// --- Test lifecycle ---

const submittedOrders: string[] = [];
afterEach(async () => {
	const timing = createTimingLog("partial-fill-hooks cleanup");
	await cancelOrders(traderWallet, submittedOrders.splice(0));
	timing("remaining partial orders cancelled");
});

beforeAll(async () => {
	const timing = createTimingLog("permit hooks setup");
	await assertE2ePrerequisites(E2E_FIXTURES.hooks);
	timing("seeded prerequisites verified");
});

// No snapshot revert — chain state persists across test files so the
// BYOS balance cache stays warm for subsequent files using the same sub-solver.

// --- Tests ---

describe("partial fill with hooks", () => {
	it("ERC-2612 permit pre-hook and post-hook settle on a partial fill", {
		timeout: 220_000,
	}, async () => {
		const timing = createTimingLog("permit hooks");
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const orderSellAmount = 2_000_000_000n; // 2000 USDC (full order, partially fillable)
		const fillAmount = 1_000_000_000n; // 1000 USDC (50% fill)

		// 1. Sign ERC-2612 permit for the fill amount.
		//    This is the ONLY source of VaultRelayer allowance — no approve() is called.
		const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
		const permitCalldata = await signEip2612Permit(
			traderWallet,
			publicClient,
			sellToken,
			"USD Coin",
			"2",
			CONTRACTS.vaultRelayer,
			fillAmount,
			permitDeadline,
		);

		// The orderbook wraps raw hooks in HooksTrampoline.execute itself.
		// Wrapping here too would call execute from the trampoline rather than
		// settlement, causing the permit hook to revert.
		const permitNonceBefore = await publicClient.readContract({
			address: sellToken,
			abi: parseAbi(["function nonces(address) view returns (uint256)"]),
			functionName: "nonces",
			args: [HOOK_TRADER.address],
		});
		// 4. Build and register the CoW appData JSON with hooks.
		//    The pre-hook runs before sell token transfer (grants allowance).
		//    The post-hook runs after settlement (benign read).
		const hooksDoc = JSON.stringify({
			metadata: {
				hooks: {
					pre: [
						{
							target: sellToken,
							callData: permitCalldata,
							gasLimit: "200000",
						},
					],
					post: [
						{
							target: buyToken,
							callData: "0x95d89b41",
							gasLimit: "100000",
						},
					],
				},
			},
		});
		const hooksAppDataHash = appDataHash(hooksDoc);
		await registerAppData(hooksAppDataHash, hooksDoc);

		// 5. Get quote and compute order buy amount limit.
		const [, expectedBuyAmount] = await getAmountsOut(publicClient, fillAmount, [
			sellToken,
			buyToken,
		]);
		if (expectedBuyAmount === undefined) throw new Error("missing quote");
		timing("permit signed, hooks registered, quote fetched");
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;
		// Scale the limit price from the fill amount to the full order amount
		const orderBuyAmount = (minBuyAmount * orderSellAmount) / fillAmount;

		// 6. Submit the partially fillable order with hooks in appData.
		//    No VaultRelayer approve — the permit pre-hook handles it.
		const validTo = Math.floor(Date.now() / 1000) + 600;
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: HOOK_TRADER.address,
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
		submittedOrders.push(orderUid);
		timing(`order accepted: ${orderUid}`);
		expect(orderUid).toBeDefined();

		const usdcBefore = await tokenBalance(publicClient, sellToken, HOOK_TRADER.address);
		const wethBefore = await tokenBalance(publicClient, buyToken, HOOK_TRADER.address);

		// 7. Submit proposal for the partial fill.
		//    The solve response will include the permit pre-hook in preInteractions
		//    and the post-hook in postInteractions.
		const interactions = buildSellInteractions(sellToken, buyToken, fillAmount, minBuyAmount);
		const { id: proposalId } = await submitProposalUntilTrade(
			{
				walletClient: subSolverWallet,
				orderUid,
				sellToken,
				buyToken,
				sellAmount: fillAmount,
				minBuyAmount,
				quoteBuyAmount: expectedBuyAmount,
				interactions,
			},
			90_000,
			timing,
		);
		expect(proposalId).toBeGreaterThan(0);

		// 8. Verify partial fill: trader spent ≤ fillAmount USDC
		const usdcAfter = await tokenBalance(publicClient, sellToken, HOOK_TRADER.address);
		const spent = usdcBefore - usdcAfter;
		expect(spent).toBeGreaterThan(0n);
		expect(spent).toBeLessThanOrEqual(fillAmount);

		// 9. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, HOOK_TRADER.address);
		expect(wethBalance).toBeGreaterThan(wethBefore);

		// 10. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
		const nonceAfter = await publicClient.readContract({
			address: sellToken,
			abi: parseAbi(["function nonces(address) view returns (uint256)"]),
			functionName: "nonces",
			args: [HOOK_TRADER.address],
		});
		expect(nonceAfter).toBe(permitNonceBefore + 1n);
		const allowanceAfter = await publicClient.readContract({
			address: sellToken,
			abi: erc20Abi,
			functionName: "allowance",
			args: [HOOK_TRADER.address, CONTRACTS.vaultRelayer],
		});
		expect(allowanceAfter).toBe(0n);
		timing("partial fill and hook settlement verified");
	});
});
