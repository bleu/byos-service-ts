import { Hono } from "hono";
import type { Hex } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { SettlementOutcome } from "../../domain/proposal.js";
import * as store from "../storage.js";
import { AppError, Kind } from "./error.js";
import { type Notification, notificationSchema } from "./types.js";

export interface NotifyConfig {
	db: Db;
	onAuditEvent: (event: AuditEvent) => void;
}

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
		const auctionId = notification.auctionId ? Number(notification.auctionId) : 0;
		const solutionIds = parseSolutionIds(notification.solutionId);

		// Attribute proposals via solutions table
		const proposals =
			auctionId > 0 ? await store.solutionProposals(config.db, auctionId, solutionIds) : [];

		const outcome = outcomeOf(notification);
		if (!outcome) {
			// Evidence-only notification (pre-submission), no state change
			return c.json({ status: "ok" });
		}

		for (const proposal of proposals) {
			const result = await store.applySettlementOutcome(config.db, proposal, outcome);
			if ("kind" in result) continue; // Store error, skip
			if (result.auditEvent) {
				config.onAuditEvent(result.auditEvent);
			}
		}

		return c.json({ status: "ok" });
	});

	return app;
}
