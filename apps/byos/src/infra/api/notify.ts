import { Hono } from "hono";
import type { Logger } from "pino";
import type { Hex } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { isChargeable, type Proposal, type SettlementOutcome } from "../../domain/proposal.js";
import { recordSettlementNotification } from "../settlement-attempts.js";
import * as store from "../storage.js";
import { AppError, Kind } from "./error.js";
import { type Notification, notificationSchema } from "./types.js";

export interface NotifyConfig {
	db: Db;
	onAuditEvent: (event: AuditEvent) => void;
	logger?: Logger;
}

/** The kinds that describe the fate of a submitted settlement — the ones
 * whose loss of attribution is alert-worthy (ADR-0010). */
const OUTCOME_KINDS = new Set([
	"settlementStarted",
	"success",
	"revert",
	"cancelled",
	"expired",
	"fail",
]);

function outcomeOf(notification: Notification): SettlementOutcome | null {
	switch (notification.kind) {
		case "settlementStarted":
			return { kind: "started" };
		case "success":
			if (!notification.transaction) return null;
			return { kind: "succeeded", txHash: notification.transaction as Hex };
		case "revert":
			if (!notification.transaction) return null;
			return { kind: "reverted", txHash: notification.transaction as Hex };
		case "cancelled":
		case "expired":
		case "fail":
			return { kind: "abandoned" };
		default:
			return null;
	}
}

function parseSolutionIds(raw: Notification["solutionId"]): number[] {
	if (raw == null) return [];
	return [...new Set(Array.isArray(raw) ? raw : [raw])];
}

/** Audit evidence for a driver notification that caused no transition —
 * after the retention sweep this row is all that remains of "the driver
 * told us something we did not act on" (ADR-0010). */
function driverNotified(proposal: Proposal, notificationKind: string): AuditEvent {
	return {
		occurredAt: new Date(),
		kind: {
			type: "driverNotified",
			proposalId: proposal.id,
			subSolver: proposal.subSolver,
			orderUid: proposal.orderUid,
			notificationKind,
		},
	};
}

export function createNotifyRoute(config: NotifyConfig) {
	const app = new Hono();
	const log = config.logger?.child({ component: "notify" });

	app.post("/notify", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			throw new AppError(Kind.BadRequest, "Invalid JSON body");
		}
		const parsed = notificationSchema.safeParse(raw);
		if (!parsed.success) {
			throw new AppError(Kind.BadRequest, "Invalid notification body");
		}
		const notification = parsed.data;
		const solutionIds = parseSolutionIds(notification.solutionId);
		const kind = notification.kind;

		// In the new design, solutionId IS the proposal id.
		// Look up in both proposals table and proposals_log (for already-deleted rows).
		const proposals =
			solutionIds.length > 0
				? (await Promise.all(solutionIds.map((id) => store.getIncludingLog(config.db, id)))).filter(
						(p): p is Proposal => p !== null,
					)
				: [];

		if (proposals.length === 0) {
			if (OUTCOME_KINDS.has(kind)) {
				// An outcome we cannot join to a solution means the solutions
				// record is broken or lost — alert-worthy (ADR-0010).
				log?.error(
					{ kind, auctionId: notification.auctionId },
					"unattributable outcome notification",
				);
			}
			return c.json({ status: "ok" });
		}

		// Financial evidence commits before operational state changes. A loss status
		// cannot authorize a debit, and notifications must match the auction.
		if (!(await recordSettlementNotification(config.db, notification, log))) {
			log?.warn(
				{ kind, auctionId: notification.auctionId, solutionIds },
				"notification requires attribution review; proposal transition skipped",
			);
			return c.json({ status: "ok" });
		}

		const outcome = outcomeOf(notification);
		if (!outcome) {
			// Kinds that carry no transition: pre-submission rejections, future
			// additions, and outcome kinds whose tx hash is missing. Evidence
			// only, no row mutation (ADR-0013).
			for (const proposal of proposals) {
				if (OUTCOME_KINDS.has(kind)) {
					log?.error(
						{ id: proposal.id, kind },
						"outcome notification without a tx hash; no financial outcome recorded",
					);
				}
				config.onAuditEvent(driverNotified(proposal, kind));
			}
			return c.json({ status: "ok" });
		}

		for (const proposal of proposals) {
			// If the live row was deleted by the outcome worker (proposal.status ===
			// "lost" means it came from proposals_log), a late success or revert
			// must be written directly to the log rather than through the live table.
			const isLogOnly = proposal.status === "lost";
			const lateCorrection =
				isLogOnly && (outcome.kind === "succeeded" || outcome.kind === "reverted")
					? await store.applyLateLostCorrection(
							config.db,
							proposal.id,
							outcome as
								| { kind: "succeeded"; txHash: `0x${string}` }
								| { kind: "reverted"; txHash: `0x${string}` },
						)
					: null;

			if (lateCorrection !== null) {
				if ("kind" in lateCorrection) {
					log?.error({ id: proposal.id, kind }, "late lost correction not recorded");
					continue;
				}
				config.onAuditEvent(lateCorrection.auditEvent);
				log?.info(
					{ id: proposal.id, subSolver: proposal.subSolver, outcome: outcome.kind },
					"late settlement outcome corrected lost proposal in log",
				);
				continue;
			}

			const result = await store.applySettlementOutcome(config.db, proposal, outcome);
			if ("kind" in result) {
				// An abandonment can delete the live row after this request read it.
				// Retry the guarded log correction so a concurrent terminal notification
				// still drives settlement accounting rather than being lost to that race.
				if (
					result.kind === "notFound" &&
					(outcome.kind === "succeeded" || outcome.kind === "reverted")
				) {
					const correction = await store.applyLateLostCorrection(config.db, proposal.id, outcome);
					if ("auditEvent" in correction) {
						config.onAuditEvent(correction.auditEvent);
						log?.info(
							{ id: proposal.id, outcome: outcome.kind },
							"concurrent settlement outcome corrected lost proposal",
						);
						continue;
					}
				}
				// A write we could not perform on a money path: the debit that
				// should follow a revert now depends on the timeout backstop.
				log?.error({ id: proposal.id, kind }, "settlement outcome not recorded");
				continue;
			}
			if (result.auditEvent) {
				config.onAuditEvent(result.auditEvent);
				for (const auditEvent of result.cancelledAuditEvents) {
					config.onAuditEvent(auditEvent);
				}
				if (outcome.kind === "succeeded") {
					log?.info(
						{
							id: proposal.id,
							subSolver: proposal.subSolver,
							orderUid: proposal.orderUid,
							txHash: outcome.txHash,
						},
						"proposal settled",
					);
				} else if (outcome.kind === "reverted") {
					log?.warn(
						{
							id: proposal.id,
							subSolver: proposal.subSolver,
							orderUid: proposal.orderUid,
							txHash: outcome.txHash,
						},
						"proposal reverted",
					);
				} else {
					log?.info(
						{
							id: proposal.id,
							subSolver: proposal.subSolver,
							orderUid: proposal.orderUid,
							outcome: notification.kind,
						},
						"proposal abandoned",
					);
				}
				continue;
			}
			// Not legal from the committed status: a duplicate notification, or
			// a cancellation got there first. Recorded as evidence either way —
			// for a chargeable outcome this is a charge nobody collected.
			config.onAuditEvent(driverNotified(proposal, kind));
			if (isChargeable(outcome)) {
				log?.error(
					{ id: proposal.id, kind },
					"chargeable outcome ignored; the sub-solver may go uncharged",
				);
			} else if (outcome.kind !== "started") {
				log?.warn(
					{ id: proposal.id, kind },
					"settlement outcome not applicable to the proposal's current status",
				);
			}
		}

		return c.json({ status: "ok" });
	});

	return app;
}
