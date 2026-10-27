import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { PublicClient } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import * as store from "../storage.js";

export interface OutcomeWorkerConfig {
	db: Db;
	publicClient: PublicClient;
	settlementAddress: `0x${string}`;
	/**
	 * Approximate milliseconds per block on this chain (e.g. 12000 for mainnet).
	 * Used to convert wall-clock staleness window into a block range.
	 */
	blockDurationMs: number;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

/**
 * Number of minutes a submitted proposal must be older before the outcome
 * worker declares it lost. Long enough for a normal settlement cycle to complete.
 */
const STALENESS_WINDOW_MINS = 2;

export function createOutcomeWorker(connection: Redis, config: OutcomeWorkerConfig): Worker {
	return new Worker("outcome", async () => runOutcomeCheck(config), {
		connection,
		prefix: "byos",
		concurrency: 1,
	});
}

/**
 * Fetches the set of orderUids that appear in Trade events within the last
 * `windowBlocks` blocks before `currentBlock`.
 */
/** Minimal ABI for the Settlement Trade event. */
const TRADE_EVENT = {
	type: "event",
	name: "Trade",
	inputs: [
		{ name: "owner", type: "address", indexed: true },
		{ name: "sellToken", type: "address", indexed: false },
		{ name: "buyToken", type: "address", indexed: false },
		{ name: "sellAmount", type: "uint256", indexed: false },
		{ name: "buyAmount", type: "uint256", indexed: false },
		{ name: "feeAmount", type: "uint256", indexed: false },
		{ name: "orderUid", type: "bytes", indexed: false },
	],
} as const;

async function fetchTradedOrderUids(
	client: PublicClient,
	settlementAddress: `0x${string}`,
	fromBlock: bigint,
	toBlock: bigint,
): Promise<Set<string>> {
	const logs = await client.getLogs({
		address: settlementAddress,
		event: TRADE_EVENT,
		fromBlock,
		toBlock,
	});

	const traded = new Set<string>();
	for (const log of logs) {
		if (log.args.orderUid) {
			traded.add(log.args.orderUid.toLowerCase());
		}
	}
	return traded;
}

export async function runOutcomeCheck(config: OutcomeWorkerConfig): Promise<void> {
	const { db, publicClient, settlementAddress, blockDurationMs, onAuditEvent, logger } = config;

	// Find all submitted proposals that have been waiting longer than the staleness window.
	const windowMs = STALENESS_WINDOW_MINS * 60 * 1000;
	let stale: Awaited<ReturnType<typeof store.fetchStaleSubmitted>>;
	try {
		stale = await store.fetchStaleSubmitted(db, windowMs);
	} catch (e) {
		logger.error({ err: e }, "outcome worker: failed to fetch stale submitted proposals");
		return;
	}

	if (stale.length === 0) return;

	// Fetch on-chain Trade events for the same window.
	let currentBlock: bigint;
	try {
		currentBlock = await publicClient.getBlockNumber();
	} catch (e) {
		logger.error({ err: e }, "outcome worker: failed to get current block number");
		return;
	}

	const windowBlocks = BigInt(Math.ceil(windowMs / blockDurationMs));
	const fromBlock = currentBlock > windowBlocks ? currentBlock - windowBlocks : 0n;

	let tradedOrderUids: Set<string>;
	try {
		tradedOrderUids = await fetchTradedOrderUids(
			publicClient,
			settlementAddress,
			fromBlock,
			currentBlock,
		);
	} catch (e) {
		logger.error({ err: e }, "outcome worker: failed to fetch Trade events");
		return;
	}

	for (const proposal of stale) {
		const wasFilled = tradedOrderUids.has(proposal.orderUid.toLowerCase());
		const reason = wasFilled ? "SolverOutbid" : "UnknownOutput";

		try {
			const result = await store.applyLostOutcome(db, proposal.id, reason);
			if (result.kind === "notFound") {
				// Already processed by /notify or a concurrent tick — no action.
				continue;
			}
			if (result.kind === "staleTransition") {
				// Proposal already moved to a terminal state — no action.
				continue;
			}
			onAuditEvent(result.auditEvent);
			logger.info(
				{
					id: proposal.id,
					subSolver: proposal.subSolver,
					orderUid: proposal.orderUid,
					reason,
				},
				"outcome worker: proposal marked lost",
			);
		} catch (e) {
			logger.error({ err: e, id: proposal.id }, "outcome worker: failed to mark proposal lost");
		}
	}
}
