/**
 * Solve/notify edge-case e2e tests.
 *
 * These call the internal BYOS endpoints directly where possible,
 * avoiding the full autopilot cycle for faster execution.
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */
import { pad } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
	postNotify,
	postSolve,
	signAndSubmitProposal,
	waitForProposalStatus,
} from "./helpers/byos.js";
import { deployerWallet, publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	type GpvOrder,
	getAmountsOut,
	signAndSubmitOrder,
} from "./helpers/orderbook.js";

// --- Test lifecycle ---

beforeAll(async () => {
	await depositToEscrow(
		subSolverWallet,
		publicClient,
		ACCOUNTS.subSolver.address,
		1_000_000_000_000_000_000n, // 1 ETH
	);
	await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);

	await fundToken(
		deployerWallet,
		publicClient,
		CONTRACTS.usdc,
		ACCOUNTS.trader.address,
		3_000_000_000n, // 3000 USDC
	);
	await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.usdc);
});

// No snapshot revert — chain state persists across test files so the
// BYOS balance cache stays warm for subsequent files using the same sub-solver.

// --- Helpers ---

/**
 * Reference prices in CoW auctions: amount_in_eth = token_amount * refPrice / 1e18.
 * USDC (6 dec): 1 USDC ≈ $1 ≈ 1/2000 ETH → refPrice ≈ 5e26 per atom
 * WETH (18 dec): 1 WETH = 1 ETH → refPrice = 1e18 per atom
 */
const REF_PRICES: Record<string, string> = {
	[CONTRACTS.usdc]: "500000000000000000000000000",
	[CONTRACTS.weth]: "1000000000000000000",
	[CONTRACTS.dai]: "500000000000000000000000000",
};

/** Build a valid auction body for the /solve endpoint. */
function buildAuction(
	orderUid: string,
	order: GpvOrder,
	auctionId: string | null = "99999",
): Record<string, unknown> {
	return {
		id: auctionId,
		tokens: {
			[order.sellToken]: {
				referencePrice: REF_PRICES[order.sellToken] ?? "1000000000000000000",
				availableBalance: order.sellAmount.toString(),
				trusted: true,
			},
			[order.buyToken]: {
				referencePrice: REF_PRICES[order.buyToken] ?? "1000000000000000000",
				availableBalance: "0",
				trusted: true,
			},
		},
		orders: [
			{
				uid: orderUid,
				sellToken: order.sellToken,
				buyToken: order.buyToken,
				sellAmount: order.sellAmount.toString(),
				fullSellAmount: order.sellAmount.toString(),
				buyAmount: order.buyAmount.toString(),
				fullBuyAmount: order.buyAmount.toString(),
				validTo: order.validTo,
				kind: order.kind,
				owner: ACCOUNTS.trader.address,
				partiallyFillable: order.partiallyFillable,
				preInteractions: [],
				postInteractions: [],
				sellTokenSource: "erc20",
				buyTokenDestination: "erc20",
				class: "market",
				appData: order.appData,
				signingScheme: "eip712",
				signature: `0x${"aa".repeat(65)}`,
			},
		],
		effectiveGasPrice: "10000000000",
		deadline: new Date(Date.now() + 60_000).toISOString(),
	};
}

/** Submit a standard sell order + proposal and return both IDs. */
async function submitOrderAndProposal(opts?: { validUntilOffset?: number }) {
	const sellToken = CONTRACTS.usdc;
	const buyToken = CONTRACTS.weth;
	const sellAmount = 1_000_000_000n; // 1000 USDC

	const amounts = await getAmountsOut(publicClient, sellAmount, [sellToken, buyToken]);
	const expectedBuyAmount = amounts[1];
	const minBuyAmount = (expectedBuyAmount * 95n) / 100n;

	const validTo = Math.floor(Date.now() / 1000) + 600;
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

	const interactions = buildSellInteractions(sellToken, buyToken, sellAmount, minBuyAmount);

	const { id: proposalId } = await signAndSubmitProposal({
		walletClient: subSolverWallet,
		orderUid,
		sellAmount,
		minBuyAmount,
		quoteBuyAmount: expectedBuyAmount,
		interactions,
		validUntilOffset: opts?.validUntilOffset,
	});

	return { orderUid, proposalId, order };
}

// --- Tests ---

describe("solve edge cases", () => {
	it("settlement failure marks proposal as settleFailed", async () => {
		// 1. Submit order + proposal and wait for it to pass simulation
		const { orderUid, proposalId, order } = await submitOrderAndProposal();

		await waitForProposalStatus(subSolverWallet, proposalId, ["active"], 60_000);

		// 2. POST /solve directly to record a solution attribution
		const auction = buildAuction(orderUid, order, "88888");
		const solveResult = await postSolve(auction);
		expect(solveResult.status).toBe(200);

		const solutions = (solveResult.body as { solutions: { id: number }[] }).solutions;
		expect(solutions.length).toBeGreaterThan(0);
		const solutionId = solutions[0].id;

		// 3. Simulate driver notifications: started → revert
		const notifyStarted = await postNotify({
			auctionId: "88888",
			solutionId,
			kind: "settlementStarted",
		});
		expect(notifyStarted.status).toBe(200);

		const notifyRevert = await postNotify({
			auctionId: "88888",
			solutionId,
			kind: "revert",
			transaction: `0x${"bb".repeat(32)}`,
		});
		expect(notifyRevert.status).toBe(200);

		// 4. Verify proposal reached settleFailed
		const proposal = await waitForProposalStatus(
			subSolverWallet,
			proposalId,
			["settleFailed"],
			15_000,
		);
		expect(proposal.status).toBe("settleFailed");
	});

	it("proposal with bad interactions is rejected by simulation", async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const sellAmount = 1_000_000_000n;

		const amounts = await getAmountsOut(publicClient, sellAmount, [sellToken, buyToken]);
		const expectedBuyAmount = amounts[1];
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;

		const validTo = Math.floor(Date.now() / 1000) + 600;
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

		// Build interactions that will revert: swap with impossibly high minAmountOut
		const badInteractions = buildSellInteractions(
			sellToken,
			buyToken,
			sellAmount,
			expectedBuyAmount * 1000n, // impossibly high minimum output
		);

		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellAmount,
			minBuyAmount,
			quoteBuyAmount: expectedBuyAmount,
			interactions: badInteractions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// Wait for validator to reject via simulation failure
		const proposal = await waitForProposalStatus(
			subSolverWallet,
			proposalId,
			["simFailed", "rejected"],
			60_000,
		);
		expect(["simFailed", "rejected"]).toContain(proposal.status);
	});
});
