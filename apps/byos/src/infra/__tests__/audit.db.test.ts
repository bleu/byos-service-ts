import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../../test/setup.js";
import { createTestDb } from "../../../test/setup.js";
import { auditEvents } from "../../db/schema.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { Proposal } from "../../domain/proposal.js";
import { insertAuditEvent } from "../audit.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

function sampleProposal(): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [],
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
		pendingCancellation: false,
	};
}

describe("audit persistence", () => {
	it("inserts a received event", async () => {
		const event: AuditEvent = {
			occurredAt: new Date(),
			kind: { type: "received", proposal: sampleProposal() },
		};

		await insertAuditEvent(ctx.db, event);

		const rows = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, "received"));

		expect(rows.length).toBeGreaterThanOrEqual(1);
		const row = rows.at(-1);
		if (!row) throw new Error("received audit event missing");
		expect(row.eventType).toBe("received");
		expect(row.proposalId).toBe(1);
	});

	it("inserts a status changed event", async () => {
		const event: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "statusChanged",
				proposalId: 2,
				subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
				orderUid: `0x${"ab".repeat(56)}`,
				from: "submitted",
				to: "active",
				rejectionReason: null,
				settlementTxHash: null,
			},
		};

		await insertAuditEvent(ctx.db, event);

		const rows = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, "validated"));

		expect(rows.length).toBeGreaterThanOrEqual(1);
		const row = rows.at(-1);
		if (!row) throw new Error("validated audit event missing");
		expect(row.proposalId).toBe(2);
		expect((row.payload as Record<string, unknown>).from).toBe("submitted");
		expect((row.payload as Record<string, unknown>).to).toBe("active");
	});

	it("inserts a cancelled event", async () => {
		const event: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "cancelled",
				proposalId: 3,
				subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
				orderUid: `0x${"ab".repeat(56)}`,
			},
		};

		await insertAuditEvent(ctx.db, event);

		const rows = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, "cancelled"));

		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	it("persists a nonce conflict against the original proposal", async () => {
		const event: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "nonceConflict",
				proposalId: 4,
				subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
				orderUid: `0x${"ab".repeat(56)}`,
				incomingFingerprint: "signed-payload-fingerprint",
			},
		};

		await insertAuditEvent(ctx.db, event);

		const [row] = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, "nonce_conflict"));
		expect(row).toMatchObject({ proposalId: 4, eventType: "nonce_conflict" });
		if (!row) throw new Error("nonce conflict audit event missing");
		expect((row.payload as Record<string, unknown>).incomingFingerprint).toBe(
			"signed-payload-fingerprint",
		);
	});
});
