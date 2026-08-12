import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { type AuditKind, auditPayload, eventType } from "../../../domain/audit.js";
import type { Proposal } from "../../../domain/proposal.js";
import { serializeAuditKind } from "../audit-worker.js";

function sampleProposal(): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [
			{
				target: "0x0000000000000000000000000000000000000001" as Address,
				value: 5n,
				callData: "0x" as Hex,
			},
		],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: 1_700_000_000n,
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
	};
}

describe("serializeAuditKind", () => {
	it("makes a received event JSON-safe without changing what gets persisted", () => {
		const kind: AuditKind = { type: "received", proposal: sampleProposal() };

		expect(() => JSON.stringify(kind)).toThrow(TypeError);

		const serialized = serializeAuditKind(kind);
		expect(() => JSON.stringify(serialized)).not.toThrow();
		expect(eventType(serialized)).toBe(eventType(kind));
		expect(auditPayload(serialized)).toEqual(auditPayload(kind));
	});

	it("makes a penalized event JSON-safe without changing what gets persisted", () => {
		const kind: AuditKind = {
			type: "penalized",
			proposalId: 7,
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			orderUid: `0x${"ab".repeat(56)}`,
			amount: 10_000_000_000_000_000n,
			settlementTxHash: `0x${"22".repeat(32)}` as Hex,
			penaltyTxHash: `0x${"77".repeat(32)}` as Hex,
		};

		expect(() => JSON.stringify(kind)).toThrow(TypeError);

		const serialized = serializeAuditKind(kind);
		expect(() => JSON.stringify(serialized)).not.toThrow();
		expect(eventType(serialized)).toBe("penalized");
		expect(auditPayload(serialized)).toEqual({
			amount: "10000000000000000",
			settlementTxHash: `0x${"22".repeat(32)}`,
			penaltyTxHash: `0x${"77".repeat(32)}`,
		});
	});
});
