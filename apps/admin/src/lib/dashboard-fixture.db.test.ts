import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../../byos/test/setup.js";
import { seedDashboardFixture } from "./dashboard-fixture.js";
import {
	getOverviewStats,
	getPendingPenaltiesCount,
	getProposalDetail,
	getSubsolverStats,
	listProposals,
} from "./queries.js";
import * as schema from "./schema.js";

describe("dashboard fixture", () => {
	let context: TestContext | undefined;

	afterEach(async () => {
		await context?.cleanup();
		context = undefined;
	});

	it("makes every dashboard view meaningful", async () => {
		context = await createTestDb();
		const client = postgres(context.url);
		const db = drizzle(client, { schema });
		const now = new Date("2026-09-02T12:00:00.000Z");

		try {
			await seedDashboardFixture(client, now);
			const range = {
				from: new Date("2026-09-01T12:00:00.000Z"),
				to: new Date("2026-09-02T12:00:01.000Z"),
			};
			const overview = await getOverviewStats(db, range);
			expect(overview).toMatchObject({
				received: 8,
				settled: 1,
				settleFailed: 1,
				simFailed: 1,
				penalizedCount: 1,
				bufferDebitedCount: 1,
			});
			expect(await getSubsolverStats(db, range)).toHaveLength(3);
			const proposals = await listProposals(db, { page: 1, limit: 20 });
			expect(proposals.total).toBe(10);
			expect(new Set(proposals.items.map((proposal) => proposal.status))).toEqual(
				new Set([
					"submitted",
					"active",
					"executing",
					"rejected",
					"simFailed",
					"settled",
					"settleFailed",
					"penalized",
				]),
			);
			expect(await getPendingPenaltiesCount(db)).toBe(1);
			const penalized = proposals.items.find((proposal) => proposal.status === "penalized");
			expect(penalized).toBeDefined();
			expect(
				(await getProposalDetail(db, penalized!.id))?.auditTrail.map((event) => event.eventType),
			).toContain("penalized");
		} finally {
			await client.end();
		}
	});
});
