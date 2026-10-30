import { encodeTrampolineInteractions } from "@byos/common";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { perProposalCL } from "../../domain/collateral.js";
import { gasCutSize } from "../../domain/gas-cut.js";
import {
	effectiveGas,
	type Candidate as ScoringCandidate,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import type { ValidateProposal } from "../../domain/validator.js";
import {
	auctionOrderToRecord,
	clearAuctionStateIfOwned,
	setAuctionState,
} from "../auction-state.js";
import type { Candidate, CandidateStore } from "../candidate-store.js";
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
	candidateStore: CandidateStore;
	validator: ValidateProposal;
	onAuditEvent: (event: AuditEvent) => void;
	selectorBufferMs?: number;
	/** Subsolver /solve endpoints to forward each auction to (fire-and-forget). */
	subsolvingEndpoints?: string[];
	logger?: Logger;
}

const U64_MAX = 2n ** 64n - 1n;

export function createSolveRoute(config: SolveConfig) {
	const app = new Hono();
	const log = config.logger?.child({ component: "solve" });

	app.post("/solve", async (c) => {
		log?.debug("/solve received");
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

		log?.debug(
			{ auctionId: auction.id ?? null, orderCount: auction.orders.length },
			"/solve received",
		);

		// Forward auction to configured subsolvers (fire-and-forget).
		if (config.subsolvingEndpoints && config.subsolvingEndpoints.length > 0) {
			const body = JSON.stringify(raw);
			for (const endpoint of config.subsolvingEndpoints) {
				fetch(`${endpoint}/solve`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				}).catch((err: unknown) => {
					log?.info({ endpoint, err }, "subsolver forward failed");
				});
			}
		}

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
					.map(([addr, t]) => [addr.toLowerCase(), BigInt(t.referencePrice ?? 0)]),
			);
			const gasPrice = publishGasPrice ? auctionGasPrice : 0n;
			await setAuctionState({ auctionId, orders, prices, gasPrice });

			// Reset the escrow balance cache for the new auction, then prefetch
			// balances for all known sub-solvers in one multicall so the competition
			// window starts with a warm cache.
			config.validator.beginAuction?.();
			const subSolvers = await store.allSubSolvers(config.db);
			void config.validator.prefetchBalances?.(subSolvers);
		}

		// Keep the competition window open, then leave time to select and respond.
		const snapshotDeadlineMs =
			new Date(auction.deadline).getTime() - (config.selectorBufferMs ?? 200);
		const waitMs = Math.max(0, snapshotDeadlineMs - Date.now());
		if (waitMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}

		// Take a snapshot of candidates for this auction (real auctions only).
		// Quote requests read candidates without modifying them.
		const snapshot: Candidate[] =
			auctionId !== null ? config.candidateStore.snapshotForAuction(auctionId) : [];

		// Group snapshot candidates by order UID for O(1) lookup.
		const snapshotByOrder = new Map<string, Candidate[]>();
		for (const c of snapshot) {
			const key = c.orderUid.toLowerCase();
			const list = snapshotByOrder.get(key);
			if (list) list.push(c);
			else snapshotByOrder.set(key, [c]);
		}

		// For quote requests (no auction ID) read all candidates.
		const quoteCandidatesByOrder =
			auctionId === null
				? (() => {
						const m = new Map<string, Candidate[]>();
						for (const c of config.candidateStore.getAll()) {
							const key = c.orderUid.toLowerCase();
							const list = m.get(key);
							if (list) list.push(c);
							else m.set(key, [c]);
						}
						return m;
					})()
				: null;

		const solutions: Solution[] = [];
		const selectedCandidateIds: number[] = [];
		const selectedOrderUids = new Set<string>();

		for (const order of auction.orders) {
			const candidates =
				auctionId !== null
					? (snapshotByOrder.get(order.uid.toLowerCase()) ?? [])
					: (quoteCandidatesByOrder?.get(order.uid.toLowerCase()) ?? []);
			if (candidates.length === 0) continue;

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
			let bestCandidate: Candidate | null = null;
			let bestCut: ReturnType<typeof gasCutSize> = null;

			for (const candidate of candidates) {
				// Skip expired
				if (candidate.validUntil <= now) continue;

				// Skip candidates whose fill exceeds the remaining auction amount
				if (order.partiallyFillable) {
					const effectiveBuy =
						candidate.simulationBuyAmount != null &&
						candidate.simulationBuyAmount < candidate.quoteBuyAmount
							? candidate.simulationBuyAmount
							: candidate.quoteBuyAmount;
					const exceeds =
						order.kind === "sell"
							? candidate.sellAmount > BigInt(order.sellAmount)
							: effectiveBuy > BigInt(order.buyAmount);
					if (exceeds) continue;
				}

				const gasCost = effectiveGas(candidate.gasUsed) * auctionGasPrice;
				const effectiveBuy =
					candidate.simulationBuyAmount != null &&
					candidate.simulationBuyAmount < candidate.quoteBuyAmount
						? candidate.simulationBuyAmount
						: candidate.quoteBuyAmount;

				const scoringCandidate: ScoringCandidate = {
					orderSell: BigInt(order.sellAmount),
					orderBuy: BigInt(order.buyAmount),
					proposalSell: candidate.sellAmount,
					proposalBuy: effectiveBuy,
					isSellOrder: order.kind === "sell",
					gasCost,
				};

				const scaled = scaledToFill(scoringCandidate, order.partiallyFillable);
				if (!scaled) continue;

				const score = scoreProposal(scaled, surplusPrice);
				if (score === null || score <= 0n) continue;

				const cut = gasCutSize(scaled, sellTokenPrice);
				if (!cut) continue;

				if (score > bestScore) {
					bestScore = score;
					bestCandidate = candidate;
					bestCut = cut;
				}
			}

			if (!bestCandidate || !bestCut) continue;

			const solution = buildSolution(
				bestCandidate.id,
				order,
				bestCandidate,
				bestCandidate.gasUsed,
				bestCut,
			);
			if (!solution) continue;

			// For real auctions: insert as submitted before returning the solution.
			// Quote requests skip DB writes entirely.
			if (auctionId !== null) {
				const buyTokenRefPrice = auction.tokens[order.buyToken]?.referencePrice ?? "0";
				try {
					await store.insertAsSubmitted(
						config.db,
						bestCandidate,
						buyTokenRefPrice,
						{
							sellTokenRefPrice: tokenInfo?.referencePrice ?? "0",
							surplusTokenRefPrice: surplusTokenInfo?.referencePrice ?? "0",
							auctionGasPrice: auctionGasPrice.toString(),
							clearingPrices: solution.prices,
						},
						tokenInfo?.referencePrice && BigInt(tokenInfo.referencePrice) > 0n
							? perProposalCL(
									bestCandidate.sellAmount,
									BigInt(tokenInfo.referencePrice),
									config.collateralRatioBps ?? 4n,
									config.minCollateral ?? 10n ** 16n,
								)
							: null,
					);
				} catch {
					// If we can't record the attribution, don't bid — consistency first.
					continue;
				}
			}

			solutions.push(solution);
			selectedCandidateIds.push(bestCandidate.id);
			selectedOrderUids.add(order.uid.toLowerCase());
			log?.info(
				{
					proposalId: bestCandidate.id,
					orderUid: order.uid,
					sellToken: order.sellToken,
					buyToken: order.buyToken,
					quoteBuyAmount: bestCandidate.quoteBuyAmount.toString(),
				},
				"solution included",
			);
		}

		// Flush snapshot candidates for real auctions:
		// - Selected candidates: remove from store (now in proposals table as submitted)
		// - Non-selected candidates: write to log with flush reason
		if (auctionId !== null) {
			config.candidateStore.removeAll(selectedCandidateIds);

			const selectedSet = new Set(selectedCandidateIds);
			const toFlush = snapshot.filter((c) => !selectedSet.has(c.id));

			// Write non-selected candidates to log synchronously (before response).
			await Promise.all(
				toFlush.map((candidate) => {
					// Determine flush reason: SubsolverOutbid if the order was won by another sub-solver,
					// AuctionClosed if the order had no winner.
					const reason = selectedOrderUids.has(candidate.orderUid.toLowerCase())
						? ("SubsolverOutbid" as const)
						: ("AuctionClosed" as const);

					return store
						.writeToLog(
							config.db,
							candidate.id,
							{
								subSolver: candidate.subSolver,
								orderUid: candidate.orderUid,
								orderUidHash: candidate.orderUidHash,
								sellToken: candidate.sellToken,
								buyToken: candidate.buyToken,
								sellAmount: candidate.sellAmount,
								minBuyAmount: candidate.minBuyAmount,
								quoteBuyAmount: candidate.quoteBuyAmount,
								interactions: candidate.interactions,
								interactionsHash: candidate.interactionsHash,
								validUntil: candidate.validUntil,
								nonce: candidate.nonce,
								signature: candidate.signature,
								status: "rejected",
								rejectionReason: reason,
								gasUsed: candidate.gasUsed,
								trampoline: candidate.trampoline,
								settlementTxHash: null,
								penaltyTxHash: null,
								sellTokenRefPrice: candidate.sellTokenRefPrice,
								buyTokenRefPrice: null,
								surplusTokenRefPrice: null,
								auctionGasPrice: null,
								clearingPrices: null,
								simulationBuyAmount: candidate.simulationBuyAmount,
								settlementPenaltyCap: null,
								auctionId: candidate.auctionId,
							},
							"rejected",
							reason,
							null,
						)
						.catch(() => {
							log?.warn({ candidateId: candidate.id }, "failed to write flushed candidate to log");
						});
				}),
			);

			// Also remove flushed candidates from store
			config.candidateStore.removeAll(toFlush.map((c) => c.id));

			await clearAuctionStateIfOwned(auctionId);
		}

		if (solutions.length > 0) {
			log?.info({ proposalCount: solutions.length }, "solution sent");
		} else {
			log?.debug({ proposalCount: 0 }, "solution sent");
		}
		return c.json({ solutions } satisfies SolveResponse);
	});

	return app;
}

function buildSolution(
	id: number,
	order: AuctionOrder,
	candidate: Candidate,
	gasUsed: bigint,
	cut: { amount: bigint; executedAmount: bigint },
): Solution | null {
	const [transfer, execute] = encodeTrampolineInteractions(
		candidate.trampoline,
		{
			orderUidHash: candidate.orderUidHash,
			sellToken: candidate.sellToken,
			buyToken: candidate.buyToken,
			sellAmount: candidate.sellAmount,
			minBuyAmount: candidate.minBuyAmount,
			quoteBuyAmount: candidate.quoteBuyAmount,
			validUntil: candidate.validUntil,
			nonce: candidate.nonce,
		},
		candidate.interactions,
		candidate.signature,
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

	const effectiveBuy =
		candidate.simulationBuyAmount != null &&
		candidate.simulationBuyAmount < candidate.quoteBuyAmount
			? candidate.simulationBuyAmount
			: candidate.quoteBuyAmount;

	return {
		id,
		prices: {
			[order.sellToken]: effectiveBuy.toString(),
			[order.buyToken]: candidate.sellAmount.toString(),
		},
		trades: [trade],
		pre_interactions: order.preInteractions.map(toSolutionInteraction),
		interactions,
		post_interactions: order.postInteractions.map(toSolutionInteraction),
		gas: Number(effectiveGas(gasUsed)),
	};
}
