import type { Redis } from "ioredis";
import type { AuditKind } from "../domain/audit.js";
import {
	type SlackFormatterContext,
	slackAddress,
	slackAmount,
	slackLink,
	slackOrderUid,
	slackTx,
	tenderlyTxUrl,
} from "./formatters.js";

const KNOWN_SUBSOLVERS_KEY = "byos:known-subsolvers";

/**
 * Builds a Slack message for an audit event, or returns null if no
 * notification should be sent for this event type.
 */
export async function buildNotification(
	redis: Redis,
	kind: AuditKind,
	ctx: SlackFormatterContext,
): Promise<string | null> {
	switch (kind.type) {
		case "received": {
			const isNew = await redis.sadd(KNOWN_SUBSOLVERS_KEY, kind.proposal.subSolver);
			if (isNew === 0) return null; // already seen this subsolver
			return `🆕 New subsolver connected: ${slackAddress(kind.proposal.subSolver, ctx)}`;
		}
		case "penalized":
			return (
				`⚠️ Subsolver penalized\n` +
				`Subsolver: ${slackAddress(kind.subSolver, ctx)}\n` +
				`Order: ${slackOrderUid(kind.orderUid, ctx)}\n` +
				`Amount: ${slackAmount(kind.amount, ctx)}\n` +
				`Penalty tx: ${slackTx(kind.penaltyTxHash, ctx)}`
			);
		case "nonSettlementDebited":
			return (
				`⚠️ Subsolver non-settlement debited\n` +
				`Subsolver: ${slackAddress(kind.subSolver, ctx)}\n` +
				`Order: ${slackOrderUid(kind.orderUid, ctx)}\n` +
				`Amount: ${slackAmount(kind.amount, ctx)}\n` +
				`Penalty tx: ${slackTx(kind.penaltyTxHash, ctx)}`
			);
		case "bufferDebited":
			return (
				`💸 BYOS buffer debited\n` +
				`Subsolver: ${slackAddress(kind.subSolver, ctx)}\n` +
				`Amount: ${slackAmount(kind.amount, ctx)}\n` +
				`Entries cleared: ${kind.entryCount}\n` +
				`Tx: ${slackTx(kind.clearTxHash, ctx)}`
			);
		case "statusChanged": {
			if (kind.to === "settled") {
				const txHash = kind.settlementTxHash ?? "unknown";
				return (
					`✅ Auction won — proposal settled\n` +
					`Subsolver: ${slackAddress(kind.subSolver, ctx)}\n` +
					`Order: ${slackOrderUid(kind.orderUid, ctx)}\n` +
					`Tx: ${kind.settlementTxHash ? slackTx(kind.settlementTxHash, ctx) : txHash}`
				);
			}
			if (kind.to === "settleFailed") {
				const txHash = kind.settlementTxHash ?? "unknown";
				const tenderly = kind.settlementTxHash
					? tenderlyTxUrl(kind.settlementTxHash, ctx.chainId)
					: null;
				return (
					`❌ Settlement reverted\n` +
					`Subsolver: ${slackAddress(kind.subSolver, ctx)}\n` +
					`Order: ${slackOrderUid(kind.orderUid, ctx)}\n` +
					`Tx: ${kind.settlementTxHash ? slackTx(kind.settlementTxHash, ctx) : txHash}\n` +
					`Debug: ${slackLink(tenderly, "Tenderly")}`
				);
			}
			return null;
		}
		default:
			return null;
	}
}
