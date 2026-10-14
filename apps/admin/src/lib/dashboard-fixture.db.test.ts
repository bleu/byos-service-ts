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
			// Mixed-case stored addresses and input must select the same cohort,
			// including financial audit events and rejection breakdowns.
			const address = "0xaBcDEFabcdefABCdefabCDefAbcdefABcDEfABCD";
			await client`UPDATE proposals_log SET sub_solver = ${address}
				WHERE sub_solver = '0x3333333333333333333333333333333333333333'`;
			await client`UPDATE audit_events SET sub_solver = ${address}
				WHERE sub_solver = '0x3333333333333333333333333333333333333333'`;
			const filtered = await getOverviewStats(db, range, ` ${address.toUpperCase()} `);
			expect(filtered).toMatchObject({
				received: 3,
				settled: 1,
				settleFailed: 1,
				simFailed: 0,
				penalizedCount: 1,
				bufferDebitedCount: 0,
				rejectionBreakdown: [],
			});
			expect(await getOverviewStats(db, range, address.toLowerCase())).toEqual(filtered);
			expect(await getOverviewStats(db, range, "  ")).toEqual(overview);
			expect(
				await getOverviewStats(db, range, "0x4444444444444444444444444444444444444444"),
			).toMatchObject({
				received: 0,
				penalizedCount: 0,
				penalizedAmountWei: "0",
				rejectionBreakdown: [],
			});

			const rejectedSubSolver = await getOverviewStats(
				db,
				range,
				"0x2222222222222222222222222222222222222222",
			);
			expect(rejectedSubSolver).toMatchObject({
				received: 3,
				penalizedCount: 0,
				rejectionBreakdown: [{ reason: "invalidSignature", count: 1 }],
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
			const simFailed = proposals.items.find((proposal) => proposal.status === "simFailed");
			expect(simFailed).toBeDefined();
			const simFailedDetail = await getProposalDetail(db, simFailed!.id);
			expect(simFailedDetail?.proposal.simulationFailureParams).toMatchObject({
				chainId: 100,
				blockNumber: "12345678",
				from: expect.stringMatching(/^0x/),
				to: expect.stringMatching(/^0x/),
				calldata: expect.stringMatching(/^0x/),
			});
		} finally {
			await client.end();
		}
	});
});
