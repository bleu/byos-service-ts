import type { ContractInteraction, RejectionReason, Status } from "@byos/common";
import type { Address, Hex } from "viem";
import { hexToBytes } from "viem";

// Re-export Status as ProposalStatus for domain clarity
export type ProposalStatus = Status;

/** Domain proposal — the full internal representation post-ingestion. */
export interface Proposal {
	id: number;
	subSolver: Address;
	orderUid: string;
	orderUidHash: Hex;
	sellAmount: bigint;
	minBuyAmount: bigint;
	quotedBuyAmount: bigint;
	sellToken: Address;
	buyToken: Address;
	interactions: ContractInteraction[];
	interactionsHash: Hex;
	validUntil: bigint;
	nonce: bigint;
	signature: Hex;
	status: ProposalStatus;
	rejectionReason: RejectionReason | null;
	gasUsed: bigint | null;
	trampoline: Address | null;
	settlementTxHash: Hex | null;
	penaltyTxHash: Hex | null;
	pendingCancellation: boolean;
}

/** What the driver reported about a settlement. */
export type SettlementOutcome =
	| { kind: "started" }
	| { kind: "succeeded"; txHash: Hex }
	| { kind: "reverted"; txHash: Hex }
	| { kind: "abandoned" };

/** Whether this outcome should trigger an escrow charge. */
export function isChargeable(outcome: SettlementOutcome): boolean {
	return outcome.kind === "reverted" || outcome.kind === "abandoned";
}

/** Parse and validate a 56-byte order UID hex string. */
export function parseOrderUid(hex: string): Uint8Array {
	const normalized = hex.startsWith("0x") ? hex : `0x${hex}`;
	const bytes = hexToBytes(normalized as Hex);
	if (bytes.length !== 56) {
		throw new Error(`expected 56 bytes, got ${bytes.length}`);
	}
	return bytes;
}
