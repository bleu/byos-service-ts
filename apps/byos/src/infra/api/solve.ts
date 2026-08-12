import { encodeTrampolineInteractions } from "@byos/common";
import { Hono } from "hono";
import type { Address } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { gasCutSize } from "../../domain/gas-cut.js";
import type { Proposal } from "../../domain/proposal.js";
import {
	type Candidate,
	effectiveGas,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import type { GasPriceRef } from "../blockchain/escrow.js";
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
	db: Db;
	gasPriceRef: GasPriceRef;
	onAuditEvent: (event: AuditEvent) => void;
}

const U64_MAX = 2n ** 64n - 1n;

export function createSolveRoute(config: SolveConfig) {
	const app = new Hono();

	app.post("/solve", async (c) => {
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

		// Publish the auction's gas price for the escrow validator. A price
		// past u64::MAX is scored with but never published: the validator's
		// threshold multiplies it unbounded, which would push every sub-solver
		// under the escrow minimum and reject the live book — and Rejected is
		// terminal.
		let auctionGasPrice = config.gasPriceRef.value;
		try {
			auctionGasPrice = BigInt(auction.effectiveGasPrice);
			if (auctionGasPrice <= U64_MAX) {
				config.gasPriceRef.value = auctionGasPrice;
			}
		} catch {
			// If it doesn't parse, leave previous value
		}

		// Parse auction ID
		const auctionId = auction.id ? Number(auction.id) : 0;

		// Collect order UIDs from auction
		const orderUids = auction.orders.map((o) => o.uid);
		if (orderUids.length === 0) {
			return c.json({ solutions: [] } satisfies SolveResponse);
		}

		// Batch lookup: single query for all active proposals
		const grouped = await store.activeByOrderUids(config.db, orderUids);

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
							: proposal.buyAmount > BigInt(order.buyAmount);
					if (exceeds) continue;
				}

				// Score with the auction's own price, published or not (an
				// oversized price then legitimately produces no bids this round).
				const gasCost = effectiveGas(proposal.gasUsed) * auctionGasPrice;

				const candidate: Candidate = {
					orderSell: BigInt(order.sellAmount),
					orderBuy: BigInt(order.buyAmount),
					proposalSell: proposal.sellAmount,
					proposalBuy: proposal.buyAmount,
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

			// Record attribution
			try {
				await store.recordSolution(config.db, auctionId, solutionId, bestProposal.id);
			} catch {
				continue; // Skip solution if attribution fails
			}

			solutions.push(solution);
			solutionId++;
		}

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
		order.sellToken as Address,
		{
			orderUidHash: proposal.orderUidHash,
			sellAmount: proposal.sellAmount,
			buyAmount: proposal.buyAmount,
			validUntil: proposal.validUntil,
			nonce: proposal.nonce,
		},
		proposal.interactions,
		order.buyToken as Address,
		proposal.signature,
	);

	const interactions: SolutionInteraction[] = [transfer, execute].map((i) => ({
		target: i.target,
		value: i.value.toString(),
		callData: i.callData,
		internalize: false,
		allowances: [],
		inputs: [],
		outputs: [],
	}));

	const trade: Fulfillment = {
		orderUid: order.uid,
		executedAmount: cut.executedAmount.toString(),
		fee: cut.amount.toString(),
	};

	return {
		id,
		prices: {
			[order.sellToken]: proposal.buyAmount.toString(),
			[order.buyToken]: proposal.sellAmount.toString(),
		},
		trades: [trade],
		pre_interactions: [],
		interactions,
		post_interactions: [],
		gas: Number(effectiveGas(gasUsed)),
	};
}
