import type { Db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";
import { type AuditEvent, auditPayload, eventType } from "../domain/audit.js";

/** Inserts a single audit event into the audit_events table. */
export async function insertAuditEvent(db: Db, event: AuditEvent): Promise<void> {
	const kind = event.kind;

	let proposalId: number;
	let subSolver: string;
	let orderUid: string;
	let settlementTxHash: string | null = null;

	switch (kind.type) {
		case "received":
			proposalId = kind.proposal.id;
			subSolver = kind.proposal.subSolver.toLowerCase();
			orderUid = kind.proposal.orderUid.toLowerCase();
			break;
		case "cancelled":
		case "cancellationDeferred":
		case "driverNotified":
			proposalId = kind.proposalId;
			subSolver = kind.subSolver.toLowerCase();
			orderUid = kind.orderUid.toLowerCase();
			break;
		case "statusChanged":
			proposalId = kind.proposalId;
			subSolver = kind.subSolver.toLowerCase();
			orderUid = kind.orderUid.toLowerCase();
			settlementTxHash = kind.settlementTxHash?.toLowerCase() ?? null;
			break;
		case "penalized":
			proposalId = kind.proposalId;
			subSolver = kind.subSolver.toLowerCase();
			orderUid = kind.orderUid.toLowerCase();
			settlementTxHash = kind.settlementTxHash?.toLowerCase() ?? null;
			break;
		case "nonSettlementDebited":
			proposalId = kind.proposalId;
			subSolver = kind.subSolver.toLowerCase();
			orderUid = kind.orderUid.toLowerCase();
			break;
		case "bufferDebited":
			proposalId = 0;
			subSolver = kind.subSolver.toLowerCase();
			orderUid = "";
			break;
	}

	await db.insert(auditEvents).values({
		proposalId,
		eventType: eventType(kind),
		subSolver,
		orderUid,
		settlementTxHash,
		payload: auditPayload(kind),
		occurredAt: event.occurredAt,
	});
}
