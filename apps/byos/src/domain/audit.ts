import type { RejectionReason, Status } from "@byos/common";
import type { Address, Hex } from "viem";
import type { Proposal } from "./proposal.js";

export type AuditKind =
	| { type: "received"; proposal: Proposal }
	| { type: "cancelled"; proposalId: number; subSolver: Address; orderUid: string }
	// Emitted when a sub-solver requests cancellation while the proposal is in
	// an active auction settlement ("executing"). The proposal stays executing
	// but its pendingCancellation flag is set. When the settlement resolves:
	//   - abandoned → proposal transitions to "cancelled" (not back to "active")
	//   - succeeded/reverted → flag is cleared (proposal is terminal anyway)
	| { type: "cancellationDeferred"; proposalId: number; subSolver: Address; orderUid: string }
	| {
			type: "statusChanged";
			proposalId: number;
			subSolver: Address;
			orderUid: string;
			from: Status;
			to: Status;
			rejectionReason: RejectionReason | null;
			settlementTxHash: Hex | null;
	  }
	| {
			type: "penalized";
			proposalId: number;
			subSolver: Address;
			orderUid: string;
			amount: bigint;
			settlementTxHash: Hex | null;
			penaltyTxHash: Hex;
	  }
	| {
			type: "nonSettlementDebited";
			proposalId: number;
			subSolver: Address;
			orderUid: string;
			amount: bigint;
			penaltyTxHash: Hex;
	  }
	| {
			type: "driverNotified";
			proposalId: number;
			subSolver: Address;
			orderUid: string;
			notificationKind: string;
	  };

export interface AuditEvent {
	occurredAt: Date;
	kind: AuditKind;
}

/** Maps an audit kind to a stable event type string for storage. */
export function eventType(kind: AuditKind): string {
	switch (kind.type) {
		case "received":
			return "received";
		case "cancelled":
			return "cancelled";
		case "cancellationDeferred":
			return "cancellation_deferred";
		case "penalized":
			return "penalized";
		case "nonSettlementDebited":
			return "non_settlement_debited";
		case "driverNotified":
			return "driver_notified";
		case "statusChanged": {
			const { from, to } = kind;
			if (to === "active" && from === "executing") return "released";
			if (to === "active") return "validated";
			if (to === "rejected") return "rejected";
			if (to === "expired") return "expired";
			if (to === "executing") return "settlement_started";
			if (to === "simFailed") return "sim_failed";
			if (to === "settled") return "settled";
			if (to === "settleFailed") return "settle_failed";
			if (to === "penalized") return "penalized";
			if (to === "cancelled") return "cancelled";
			if (to === "submitted") return "resubmitted";
			return "status_changed";
		}
	}
}

/** Builds the JSON payload for audit persistence. */
export function auditPayload(kind: AuditKind): Record<string, unknown> {
	switch (kind.type) {
		case "received":
			return {
				id: kind.proposal.id,
				subSolver: kind.proposal.subSolver,
				orderUid: kind.proposal.orderUid,
				orderUidHash: kind.proposal.orderUidHash,
				sellAmount: kind.proposal.sellAmount.toString(),
				minBuyAmount: kind.proposal.minBuyAmount.toString(),
				maxBuyAmount: kind.proposal.maxBuyAmount.toString(),
				interactions: kind.proposal.interactions.map((i) => ({
					target: i.target,
					value: i.value.toString(),
					callData: i.callData,
				})),
				interactionsHash: kind.proposal.interactionsHash,
				validUntil: kind.proposal.validUntil.toString(),
				nonce: kind.proposal.nonce.toString(),
				signature: kind.proposal.signature,
			};
		case "cancelled":
			return {};
		case "cancellationDeferred":
			return {};
		case "statusChanged":
			return {
				from: kind.from,
				to: kind.to,
				...(kind.rejectionReason ? { rejectionReason: kind.rejectionReason } : {}),
				...(kind.settlementTxHash ? { settlementTxHash: kind.settlementTxHash } : {}),
			};
		case "penalized":
			return {
				amount: kind.amount.toString(),
				settlementTxHash: kind.settlementTxHash,
				penaltyTxHash: kind.penaltyTxHash,
			};
		case "nonSettlementDebited":
			return {
				amount: kind.amount.toString(),
				penaltyTxHash: kind.penaltyTxHash,
			};
		case "driverNotified":
			return {
				kind: kind.notificationKind,
			};
	}
}
