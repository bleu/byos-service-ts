import { type Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { ValidateProposal } from "../../domain/validator.js";
import * as store from "../storage.js";

/**
 * At most this many proposals are validated at once. Each validation holds
 * one RPC/orderbook request open at a time, so this bounds the in-flight
 * request burst against paid-RPC rate limits — the same protection as the
 * Rust loop's 8-permit semaphore.
 */
const VALIDATION_CONCURRENCY = 8;

export interface ValidationTickConfig {
	db: Db;
	validator: ValidateProposal;
	executingTimeoutSecs: number;
	enqueueValidation: (proposalId: number) => Promise<void>;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export interface ProposalValidationConfig {
	db: Db;
	validator: ValidateProposal;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export function createValidationWorker(connection: Redis, config: ValidationTickConfig): Worker {
	return new Worker(
		"byos:validation",
		async () => {
			await runValidationTick(config);
		},
		{
			connection,
			concurrency: 1,
		},
	);
}

/** Worker that validates one proposal per job, VALIDATION_CONCURRENCY at a time. */
export function createProposalValidationWorker(
	connection: Redis,
	config: ProposalValidationConfig,
): Worker {
	return new Worker(
		"byos:validate-proposal",
		async (job) => {
			await runProposalValidation(config, (job.data as { proposalId: number }).proposalId);
		},
		{
			connection,
			concurrency: VALIDATION_CONCURRENCY,
		},
	);
}

/**
 * The job id dedupes per proposal: while a validation is queued or running,
 * re-enqueueing the same proposal is a no-op, so an overrunning validation
 * is not stacked by the next tick. removeOnComplete frees the id so the
 * following tick can enqueue it again.
 */
export async function enqueueProposalValidation(queue: Queue, proposalId: number): Promise<void> {
	await queue.add(
		"validate-proposal",
		{ proposalId },
		{
			jobId: `proposal-${proposalId}`,
			attempts: 1,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
}

export async function runValidationTick(config: ValidationTickConfig): Promise<void> {
	const { db, validator, executingTimeoutSecs, enqueueValidation, onAuditEvent, logger } = config;

	// Signal start of tick (clears caches)
	if ("beginTick" in validator && typeof validator.beginTick === "function") {
		validator.beginTick();
	}

	// Sweep 1: Release stale executing proposals (timeout backstop)
	try {
		const released = await store.releaseStaleExecuting(db, executingTimeoutSecs);
		for (const event of released) {
			onAuditEvent(event);
		}
		if (released.length > 0) {
			logger.info({ count: released.length }, "released stale executing proposals");
		}
	} catch (e) {
		logger.error({ err: e }, "failed to release stale executing proposals");
	}

	// Sweep 2: Snapshot live proposals, expire and enqueue the rest
	let live: Awaited<ReturnType<typeof store.snapshotByStatuses>>;
	try {
		live = await store.snapshotByStatuses(db, ["submitted", "active"]);
	} catch (e) {
		logger.error({ err: e }, "failed to snapshot live proposals");
		return;
	}

	const now = BigInt(Math.floor(Date.now() / 1000));

	for (const proposal of live) {
		if (proposal.validUntil < now) {
			try {
				const result = await store.transition(db, proposal, "expired");
				if ("auditEvent" in result) {
					onAuditEvent(result.auditEvent);
				}
			} catch (e) {
				logger.debug({ err: e, id: proposal.id }, "expire transition lost");
			}
		} else {
			try {
				await enqueueValidation(proposal.id);
			} catch (e) {
				logger.warn({ err: e, id: proposal.id }, "failed to enqueue validation");
			}
		}
	}
}

/** Validates a single proposal, re-read from the store so the state is fresh. */
export async function runProposalValidation(
	config: ProposalValidationConfig,
	proposalId: number,
): Promise<void> {
	const { db, validator, onAuditEvent, logger } = config;

	const proposal = await store.get(db, proposalId);
	if (!proposal) return; // swept or never existed
	if (proposal.status !== "submitted" && proposal.status !== "active") {
		return; // a cancellation or notification won the race
	}

	try {
		const verdict = await validator.validate(proposal);
		if (!verdict) {
			logger.debug({ id: proposal.id }, "validator deferred judgment");
			return;
		}

		const result = await store.resolveVerdict(db, proposal.id, verdict);
		if ("kind" in result) {
			// Store error
			if (result.kind === "staleTransition" || result.kind === "notFound") {
				logger.debug({ id: proposal.id, error: result }, "verdict transition lost");
			} else {
				logger.warn({ id: proposal.id, error: result }, "verdict resolution failed");
			}
			return;
		}

		if (result.auditEvent) {
			onAuditEvent(result.auditEvent);
		}
	} catch (e) {
		logger.warn({ err: e, id: proposal.id }, "validation failed");
	}
}
