import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createTestDb } from "../../../test/setup.js";
import { debitOperations, settlementAttempts } from "../../db/schema.js";

it("migration 0016 parks unfinished legacy charges without erasing signed bytes or backfilling liability", async () => {
	const ctx = await createTestDb();
	try {
		// Restore the table layout immediately before 0016, then apply the actual SQL.
		await ctx.db.execute(
			sql`DROP TABLE settlement_notifications, settlement_attempt_members, settlement_attempts`,
		);
		const base = {
			sourceKind: "non-settlement",
			subSolver: `0x${"11".repeat(20)}`,
			amount: "1000",
			reason: `0x${"22".repeat(32)}`,
		};
		await ctx.db.insert(debitOperations).values([
			{ ...base, sourceId: "penalty:1", status: "pending" },
			{
				...base,
				sourceId: "penalty:2",
				status: "broadcasting",
				rawTransaction: "0xab",
				transactionHash: `0x${"33".repeat(32)}`,
				leaseOwner: "old-worker",
				leaseExpiresAt: new Date(Date.now() + 60000),
			},
			{ ...base, sourceId: "penalty:3", status: "completed", rawTransaction: "0xcd" },
			{ ...base, sourceKind: "revert", sourceId: "proposal:4", status: "pending" },
		]);
		const migration = readFileSync(
			new URL("../../../drizzle/0016_evidence_backed_penalties.sql", import.meta.url),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint"))
			await ctx.db.execute(sql.raw(statement));
		const rows = await ctx.db.select().from(debitOperations).orderBy(debitOperations.id);
		expect(rows.map((row) => row.status)).toEqual([
			"needs_reconciliation",
			"needs_reconciliation",
			"completed",
			"pending",
		]);
		expect(rows[1]?.rawTransaction).toBe("0xab");
		expect(rows[1]?.transactionHash).toBe(`0x${"33".repeat(32)}`);
		expect(rows[1]?.leaseOwner).toBeNull();
		expect(rows[1]?.leaseExpiresAt).toBeNull();
		expect(await ctx.db.select().from(settlementAttempts)).toHaveLength(0);
	} finally {
		await ctx.cleanup();
	}
});
