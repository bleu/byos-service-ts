import { encodeTrampolineInteractions } from "@byos/common";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { ProposalValidator } from "../blockchain/validator.js";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { perProposalCL } from "../../domain/collateral.js";
import { gasCutSize } from "../../domain/gas-cut.js";
import { effectiveBuyAmount, type Proposal } from "../../domain/proposal.js";
import {
	type Candidate,
	effectiveGas,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import {
	auctionOrderToRecord,
	clearAuctionStateIfOwned,
	setAuctionState,
} from "../auction-state.js";
import * as store from "../storage.js";
import { AppError, Kind } from "./error.js";
import {
	type AuctionOrder,
	auctionSchema,
	type Fulfillment,
	type Solution,
	type SolutionInteraction,
	type SolveResponse,
} from "./types.js";

export interface SolveConfig {
	minCollateral?: bigint;
	collateralRatioBps?: bigint;
	db: Db;
	validator: ProposalValidator;
	onAuditEvent: (event: AuditEvent) => void;
	selectorBufferMs?: number;
	logger?: Logger;
}

const U64_MAX = 2n ** 64n - 1n;

export function createSolveRoute(config: SolveConfig) {
	const app = new Hono();
	const log = config.logger?.child({ component: "solve" });

	app.post("/solve", async (c) => {
		log?.info("/solve received");
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			throw new AppError(Kind.BadRequest, "Invalid JSON body");
		}
		const parsed = auctionSchema.safeParse(raw);
		if (!parsed.success) {
			throw new AppError(Kind.BadRequest, "Invalid auction body");
		}
		const auction = parsed.data;

		// Parse the auction's gas price for scoring and publishing to auction state.
		// A price past u64::MAX is scored with but never published to the validator:
		// multiplying it unbounded would push every sub-solver under the escrow
		// minimum and reject the live book — Rejected is terminal.
		let auctionGasPrice = 0n;
		let publishGasPrice = false;
		try {
			auctionGasPrice = BigInt(auction.effectiveGasPrice);
			if (auctionGasPrice <= U64_MAX) {
				publishGasPrice = true;
				await store.publishAuctionGasPrice(config.db, auctionGasPrice);
			}
		} catch {
			// If it doesn't parse, use 0n (no scoring impact beyond this auction)
		}

		log?.info(
			{ auctionId: auction.id ?? null, orderCount: auction.orders.length },
			"/solve received",
		);

		// Auctions without an id are quote requests: never settled, so there
		// is nothing to attribute. A present id must be a decimal integer —
		// Rust rejects anything else at deserialization.
		let auctionId: number | null = null;
		if (auction.id) {
			const parsed = Number(auction.id);
			if (!/^\d+$/.test(auction.id) || !Number.isSafeInteger(parsed)) {
				throw new AppError(Kind.BadRequest, "Invalid auction id");
			}
			auctionId = parsed;
		}

		// Collect order UIDs from auction
		const orderUids = auction.orders.map((o) => o.uid);
		if (orderUids.length === 0) {
			// No orders → return immediately. We haven't set any state for this
			// auction, so there's nothing to clear. A real auction's state (if any)
			// must not be wiped by an unrelated empty request.
			return c.json({ solutions: [] } satisfies SolveResponse);
		}

		// Publish auction state so all replicas can validate proposals and
		// answer submissions with the correct order context.
		if (auctionId !== null) {
			const orders = new Map(
				auction.orders.map((o) => [o.uid.toLowerCase(), auctionOrderToRecord(o)]),
			);
			const prices = new Map(
				Object.entries(auction.tokens)
					.filter(([, t]) => t.referencePrice != null)
					.map(([addr, t]) => [addr.toLowerCase(), BigInt(t.referencePrice!)]),
			);
			const gasPrice = publishGasPrice ? auctionGasPrice : 0n;
			await setAuctionState({ auctionId, orders, prices, gasPrice });

			// Reset the escrow balance cache for the new auction, then prefetch
			// balances for all known sub-solvers in one multicall so the competition
			// window starts with a warm cache.
			config.validator.beginAuction();
			const subSolvers = await store.allSubSolvers(config.db);
			void config.validator.prefetchBalances(subSolvers);
		}

		// Keep the competition window open, then leave time to select and respond.
		const snapshotDeadlineMs =
			new Date(auction.deadline).getTime() - (config.selectorBufferMs ?? 200);
		const waitMs = Math.max(0, snapshotDeadlineMs - Date.now());
		if (waitMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
		const grouped = await store.activeByOrderUids(config.db, orderUids, auctionId);

		const solutions: Solution[] = [];
		let solutionId = 1;

		for (const order of auction.orders) {
			const proposals = grouped.get(order.uid.toLowerCase());
			if (!proposals || proposals.length === 0) continue;

			const tokenInfo = auction.tokens[order.sellToken];
			const surplusTkn = surplusToken(
				order.kind === "sell",
				order.sellToken as Address,
				order.buyToken as Address,
			);
			const surplusTokenInfo = auction.tokens[surplusTkn];

			const surplusPrice = surplusTokenInfo?.referencePrice
				? BigInt(surplusTokenInfo.referencePrice)
				: 0n;
			const sellTokenPrice = tokenInfo?.referencePrice ? BigInt(tokenInfo.referencePrice) : 0n;

			const now = BigInt(Math.floor(Date.now() / 1000));

			let bestScore = 0n;
			let bestProposal: Proposal | null = null;
			let bestCut: ReturnType<typeof gasCutSize> = null;
			let bestGasUsed = 0n;

			for (const proposal of proposals) {
				// Skip non-simulated proposals
				if (proposal.gasUsed === null || proposal.trampoline === null) continue;
				// Skip expired
				if (proposal.validUntil <= now) continue;

				// Skip proposals whose fill exceeds the remaining auction amount
				if (order.partiallyFillable) {
					const exceeds =
						order.kind === "sell"
							? proposal.sellAmount > BigInt(order.sellAmount)
							: effectiveBuyAmount(proposal) > BigInt(order.buyAmount);
					if (exceeds) continue;
				}

				// Score with the auction's own price, published or not (an
				// oversized price then legitimately produces no bids this round).
				const gasCost = effectiveGas(proposal.gasUsed) * auctionGasPrice;

				const candidate: Candidate = {
					orderSell: BigInt(order.sellAmount),
					orderBuy: BigInt(order.buyAmount),
					proposalSell: proposal.sellAmount,
					proposalBuy: effectiveBuyAmount(proposal),
					isSellOrder: order.kind === "sell",
					gasCost,
				};

				const scaled = scaledToFill(candidate, order.partiallyFillable);
				if (!scaled) continue;

				const score = scoreProposal(scaled, surplusPrice);
				if (score === null || score <= 0n) continue;

				const cut = gasCutSize(scaled, sellTokenPrice);
				if (!cut) continue;

				if (score > bestScore) {
					bestScore = score;
					bestProposal = proposal;
					bestCut = cut;
					bestGasUsed = proposal.gasUsed;
				}
			}

			if (!bestProposal || !bestCut) continue;

			const solution = buildSolution(solutionId, order, bestProposal, bestGasUsed, bestCut);
			if (!solution) continue;

			// Record attribution before bidding: if we cannot record it, we
			// do not bid it. Quote requests skip the write entirely.
			if (auctionId !== null) {
				const buyTokenRefPrice = auction.tokens[order.buyToken]?.referencePrice ?? "0";
				try {
					await store.recordSolution(
						config.db,
						auctionId,
						solutionId,
						bestProposal.id,
						buyTokenRefPrice,
						perProposalCL(
							bestProposal.sellAmount,
							tokenInfo?.referencePrice ? BigInt(tokenInfo.referencePrice) : null,
							config.collateralRatioBps ?? 4n,
							config.minCollateral ?? 10n ** 16n,
						),
					);
				} catch {
					continue;
				}

				// Mark all competing sub-solver proposals for the same order as
				// rejected: SubsolverOutbid. Best-effort: we never block /solve for this.
				store
					.rejectOutbidProposals(config.db, order.uid, bestProposal.subSolver)
					.catch(() => undefined);

				// Fire-and-forget: price snapshot on the proposal row; failure is non-fatal.
				store
					.saveSolutionPrices(config.db, bestProposal.id, {
						sellTokenRefPrice: tokenInfo?.referencePrice ?? "0",
						surplusTokenRefPrice: surplusTokenInfo?.referencePrice ?? "0",
						auctionGasPrice: auctionGasPrice.toString(),
						clearingPrices: solution.prices,
					})
					.catch(() => undefined);
			}

			solutions.push(solution);
			log?.info(
				{
					proposalId: bestProposal.id,
					orderUid: order.uid,
					sellToken: order.sellToken,
					buyToken: order.buyToken,
					quoteBuyAmount: bestProposal.quoteBuyAmount.toString(),
				},
				"solution included",
			);
			solutionId++;
		}
		// Close the auction window: reject all still-submitted proposals so they
		// cannot bleed into the next auction. Awaited so state is consistent before
		// the response reaches the driver.
		if (auctionId !== null) {
			await store.abandonAuctionProposals(config.db, auctionId);
			// Only clear the shared state if it still belongs to this auction.
			// An overlapping request for a newer auction may have already replaced
			// it; clearing unconditionally would wipe that newer state.
			// Quote requests (auctionId === null) never set state, so they never clear it.
			await clearAuctionStateIfOwned(auctionId);
		}

		log?.info({ proposalCount: solutions.length }, "solution sent");
		return c.json({ solutions } satisfies SolveResponse);
	});

	return app;
}

function buildSolution(
	id: number,
	order: AuctionOrder,
	proposal: Proposal,
	gasUsed: bigint,
	cut: { amount: bigint; executedAmount: bigint },
): Solution | null {
	if (!proposal.trampoline) return null;

	const [transfer, execute] = encodeTrampolineInteractions(
		proposal.trampoline,
		{
			orderUidHash: proposal.orderUidHash,
			sellToken: proposal.sellToken,
			buyToken: proposal.buyToken,
			sellAmount: proposal.sellAmount,
			minBuyAmount: proposal.minBuyAmount,
			quoteBuyAmount: proposal.quoteBuyAmount,
			validUntil: proposal.validUntil,
			nonce: proposal.nonce,
		},
		proposal.interactions,
		proposal.signature,
	);

	const interactions: SolutionInteraction[] = [transfer, execute].map((i) => ({
		kind: "custom" as const,
		target: i.target,
		value: i.value.toString(),
		callData: i.callData,
		internalize: false,
		allowances: [],
		inputs: [],
		outputs: [],
	}));

	const trade: Fulfillment = {
		kind: "fulfillment",
		order: order.uid,
		executedAmount: cut.executedAmount.toString(),
		fee: cut.amount.toString(),
	};

	const toSolutionInteraction = (i: {
		target: string;
		value: string;
		callData: string;
	}): SolutionInteraction => ({
		kind: "custom",
		target: i.target,
		value: i.value,
		callData: i.callData,
		internalize: false,
		allowances: [],
		inputs: [],
		outputs: [],
	});

	return {
		id,
		prices: {
			[order.sellToken]: effectiveBuyAmount(proposal).toString(),
			[order.buyToken]: proposal.sellAmount.toString(),
		},
		trades: [trade],
		pre_interactions: order.preInteractions.map(toSolutionInteraction),
		interactions,
		post_interactions: order.postInteractions.map(toSolutionInteraction),
		gas: Number(effectiveGas(gasUsed)),
	};
}
