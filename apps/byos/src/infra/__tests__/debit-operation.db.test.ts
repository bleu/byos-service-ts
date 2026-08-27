import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../../test/setup.js";
import * as store from "../storage.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

describe("debit operations", () => {
	it("allows only one replica to claim a chargeable event", async () => {
		const operation = await store.createDebitOperation(ctx.db, {
			sourceKind: "revert",
			sourceId: "proposal:42",
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7",
			amount: 10n,
			reason: `0x${"aa".repeat(32)}`,
		});

		const [first, second] = await Promise.all([
			store.claimDebitOperation(ctx.db, operation.id, "replica-a", 60),
			store.claimDebitOperation(ctx.db, operation.id, "replica-b", 60),
		]);

		expect([first, second].filter(Boolean)).toHaveLength(1);
	});

	it("reuses one operation for a chargeable event and lets a successor take an expired lease", async () => {
		const input = {
			sourceKind: "revert",
			sourceId: "proposal:44",
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as const,
			amount: 10n,
			reason: `0x${"cc".repeat(32)}` as const,
		};
		const first = await store.createDebitOperation(ctx.db, input);
		const duplicate = await store.createDebitOperation(ctx.db, input);
		expect(duplicate.id).toBe(first.id);

		expect(await store.claimDebitOperation(ctx.db, first.id, "replica-a", 0)).not.toBeNull();
		expect(await store.claimDebitOperation(ctx.db, first.id, "replica-b", 60)).not.toBeNull();
	});

	it("parks a failed operation after ten persisted attempts", async () => {
		const operation = await store.createDebitOperation(ctx.db, {
			sourceKind: "non-settlement",
			sourceId: "penalty:43",
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7",
			amount: 10n,
			reason: `0x${"bb".repeat(32)}`,
		});

		for (let attempt = 0; attempt < 10; attempt++) {
			await store.claimDebitOperation(ctx.db, operation.id, "replica-a", 60);
			await store.recordDebitFailure(ctx.db, operation.id, "replica-a", "RPC unavailable");
		}

		expect(await store.debitOperationStatus(ctx.db, operation.id)).toBe("needs_reconciliation");
	});
});
