import pino from "pino";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../../../test/setup.js";
import { createTestDb } from "../../../../test/setup.js";
import type { Proposal } from "../../../domain/proposal.js";
import { acceptAll } from "../../../domain/validator.js";
import * as store from "../../storage.js";
import { runProposalValidation, runValidationTick } from "../validation.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

const logger = pino({ level: "silent" });

function sampleProposal(overrides?: Partial<Omit<Proposal, "id">>): Omit<Proposal, "id"> {
	return {
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		...overrides,
	};
}

function tickConfig(enqueued: number[], executingTimeoutSecs = 3600) {
	return {
		db: ctx.db,
		validator: acceptAll,
		executingTimeoutSecs,
		enqueueValidation: async (proposalId: number) => {
			enqueued.push(proposalId);
		},
		onAuditEvent: () => {},
		logger,
	};
}

describe("validation tick", () => {
	it("expires past-validUntil proposals instead of enqueueing them", async () => {
		const { id: liveId } = await store.insert(ctx.db, sampleProposal());
		const { id: expiredId } = await store.insert(
			ctx.db,
			sampleProposal({ orderUid: `0x${"a1".repeat(56)}`, validUntil: 1_700_000_000n }),
		);

		const enqueued: number[] = [];
		await runValidationTick(tickConfig(enqueued));

		expect(enqueued).toContain(liveId);
		expect(enqueued).not.toContain(expiredId);
		expect((await store.get(ctx.db, expiredId))?.status).toBe("expired");
		expect((await store.get(ctx.db, liveId))?.status).toBe("submitted");
	});

	it("releases a stale executing proposal and enqueues it in the same tick", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a2".repeat(56)}` }));
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.transition(ctx.db, active as Proposal, "executing");

		const enqueued: number[] = [];
		await runValidationTick(tickConfig(enqueued, 0));

		expect((await store.get(ctx.db, id))?.status).toBe("active");
		expect(enqueued).toContain(id);
	});

	it("queues no non-settlement penalty for a timeout release", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a6".repeat(56)}` }));
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.transition(ctx.db, active as Proposal, "executing");

		await runValidationTick(tickConfig([], 0));

		expect((await store.get(ctx.db, id))?.status).toBe("active");
		// Only /notify's driver-confirmed abandonment may queue the 0.1 c_l
		// charge; the timeout backstop must not.
		const pending = await store.pendingPenalties(ctx.db);
		expect(pending.some((p) => p.proposalId === id)).toBe(false);
	});

	it("never touches executing proposals within the timeout", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a3".repeat(56)}` }));
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.transition(ctx.db, active as Proposal, "executing");

		const enqueued: number[] = [];
		await runValidationTick(tickConfig(enqueued));

		expect((await store.get(ctx.db, id))?.status).toBe("executing");
		expect(enqueued).not.toContain(id);
	});
});

describe("proposal validation job", () => {
	it("flips a submitted proposal to active with accept-all", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a4".repeat(56)}` }));

		await runProposalValidation(
			{ db: ctx.db, validator: acceptAll, onAuditEvent: () => {}, logger },
			id,
		);

		expect((await store.get(ctx.db, id))?.status).toBe("active");
	});

	it("marks a proposal simFailed when the validator says so", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a7".repeat(56)}` }));

		const failAll = {
			async validate() {
				return { kind: "simFailed" } as const;
			},
		};
		await runProposalValidation(
			{ db: ctx.db, validator: failAll, onAuditEvent: () => {}, logger },
			id,
		);

		const proposal = await store.get(ctx.db, id);
		expect(proposal?.status).toBe("simFailed");
		expect(proposal?.rejectionReason).toBeNull();
	});

	it("skips a proposal that left the live statuses before the job ran", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ orderUid: `0x${"a5".repeat(56)}` }));
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.transition(ctx.db, active as Proposal, "executing");

		let validated = false;
		const tracking = {
			async validate() {
				validated = true;
				return { kind: "accept", simulation: null } as const;
			},
		};
		await runProposalValidation(
			{ db: ctx.db, validator: tracking, onAuditEvent: () => {}, logger },
			id,
		);

		expect(validated).toBe(false);
		expect((await store.get(ctx.db, id))?.status).toBe("executing");
	});
});
