import { Hono } from "hono";
import type { Logger } from "pino";
import type { Hex } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { isChargeable, type Proposal, type SettlementOutcome } from "../../domain/proposal.js";
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
	return Array.isArray(raw) ? raw : [raw];
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
		// Strict integer parse, mirroring Rust's parse::<i64>().ok(): a
		// malformed id means unattributable, not an error.
		const auctionId =
			notification.auctionId && /^\d+$/.test(notification.auctionId)
				? Number(notification.auctionId)
				: 0;
		const solutionIds = parseSolutionIds(notification.solutionId);
		const kind = notification.kind;

		// Attribute proposals via solutions table
		const proposals =
			auctionId > 0 && solutionIds.length > 0
				? await store.solutionProposals(config.db, auctionId, solutionIds)
				: [];

		if (proposals.length === 0) {
			if (OUTCOME_KINDS.has(kind)) {
				// An outcome we cannot join to a solution means the solutions
				// record is broken or lost — alert-worthy (ADR-0010).
				config.logger?.error(
					{ kind, auctionId: notification.auctionId },
					"unattributable outcome notification",
				);
			}
			return c.json({ status: "ok" });
		}

		const outcome = outcomeOf(notification);
		if (!outcome) {
			// Kinds that carry no transition: pre-submission rejections, future
			// additions, and outcome kinds whose tx hash is missing. Evidence
			// only, no row mutation (ADR-0013).
			for (const proposal of proposals) {
				if (OUTCOME_KINDS.has(kind)) {
					config.logger?.error(
						{ id: proposal.id, kind },
						"outcome notification without a tx hash; left for the executing timeout",
					);
				}
				config.onAuditEvent(driverNotified(proposal, kind));
			}
			return c.json({ status: "ok" });
		}

		for (const proposal of proposals) {
			const result = await store.applySettlementOutcome(config.db, proposal, outcome);
			if ("kind" in result) {
				// A write we could not perform on a money path: the debit that
				// should follow a revert now depends on the timeout backstop.
				config.logger?.error({ id: proposal.id, kind }, "settlement outcome not recorded");
				continue;
			}
			if (result.auditEvent) {
				config.onAuditEvent(result.auditEvent);
				for (const auditEvent of result.cancelledAuditEvents) {
					config.onAuditEvent(auditEvent);
				}
				continue;
			}
			// Not legal from the committed status: a duplicate notification, or
			// a cancellation got there first. Recorded as evidence either way —
			// for a chargeable outcome this is a charge nobody collected.
			config.onAuditEvent(driverNotified(proposal, kind));
			if (isChargeable(outcome)) {
				config.logger?.error(
					{ id: proposal.id, kind },
					"chargeable outcome ignored; the sub-solver may go uncharged",
				);
			} else {
				config.logger?.warn(
					{ id: proposal.id, kind },
					"settlement outcome not applicable to the proposal's current status",
				);
			}
		}

		return c.json({ status: "ok" });
	});

	return app;
}
