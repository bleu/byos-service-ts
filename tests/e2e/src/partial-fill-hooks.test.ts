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
import { HooksTrampolineAbi } from "@byos/common";
import { encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { deployerWallet, publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
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
	tokenBalance,
	waitForTrade,
} from "./helpers/orderbook.js";

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

// --- Tests ---

describe("partial fill with hooks", () => {
	it("ERC-2612 permit pre-hook and post-hook settle on a partial fill", {
		timeout: 220_000,
	}, async () => {
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

		// 5. Get quote and compute order buy amount limit.
		const [, expectedBuyAmount] = await getAmountsOut(publicClient, fillAmount, [
			sellToken,
			buyToken,
		]);
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;
		// Scale the limit price from the fill amount to the full order amount
		const orderBuyAmount = (minBuyAmount * orderSellAmount) / fillAmount;

		// 6. Submit the partially fillable order with hooks in appData.
		//    No VaultRelayer approve — the permit pre-hook handles it.
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

		const usdcBefore = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);

		// 7. Submit proposal for the partial fill.
		//    The solve response will include the permit pre-hook in preInteractions
		//    and the post-hook in postInteractions.
		const interactions = buildSellInteractions(sellToken, buyToken, fillAmount, minBuyAmount);
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellToken,
			buyToken,
			sellAmount: fillAmount,
			minBuyAmount,
			quoteBuyAmount: expectedBuyAmount,
			interactions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// Partially fillable orders are classified as "limit" by the autopilot
		// and may take more auction cycles — use an extended timeout.
		await waitForTrade(orderUid, publicClient, 160_000);

		// 8. Verify partial fill: trader spent ≤ fillAmount USDC
		const usdcAfter = await tokenBalance(publicClient, sellToken, ACCOUNTS.trader.address);
		const spent = usdcBefore - usdcAfter;
		expect(spent).toBeGreaterThan(0n);
		expect(spent).toBeLessThanOrEqual(fillAmount);

		// 9. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(wethBalance).toBeGreaterThan(0n);

		// 10. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
	});
});
