import { randomUUID } from "node:crypto";
import { QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { expect, it } from "vitest";
import { enqueueAuditEvent } from "../audit-worker.js";
import { createQueues, setupJobSchedulers } from "../index.js";

it("bounds scheduled history, removes successful audit jobs and preserves failed audit events", async () => {
	const connection = new Redis(process.env.BYOS_TEST_REDIS_URL ?? "redis://localhost:6379", {
		maxRetriesPerRequest: null,
	});
	const prefix = `byos:test:${randomUUID()}`;
	const queues = createQueues(connection, prefix);
	const events = new QueueEvents("audit", { connection, prefix });
	const worker = new Worker(
		"audit",
		async (job) => {
			if (job.data.kind.proposalId === 2) throw new UnrecoverableError("database unavailable");
		},
		{ connection, prefix },
	);
	try {
		await events.waitUntilReady();
		await setupJobSchedulers(queues, {
			retentionSweepIntervalSecs: 300,
			penaltyIntervalSecs: 12,
			balanceRefreshIntervalSecs: 60,
		});
		for (const queue of [queues.retention, queues.penalty, queues.balanceRefresh]) {
			const jobs = await queue.getJobs(["waiting", "delayed"]);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.opts).toMatchObject({
				removeOnComplete: { count: 100, age: 86400 },
				removeOnFail: { count: 1000, age: 604800 },
			});
		}
		for (const proposalId of [1, 2]) {
			// Capture the job before processing starts so waitUntilFinished can
			// observe completion even when the successful job is removed immediately.
			await worker.pause();
			await enqueueAuditEvent(queues.audit, {
				occurredAt: new Date(),
				kind: {
					type: "cancelled",
					proposalId,
					subSolver: "0x1111111111111111111111111111111111111111",
					orderUid: "test-order",
				},
			});
			const [job] = await queues.audit.getJobs(["waiting"]);
			if (!job) throw new Error("missing audit job");
			const finished = job.waitUntilFinished(events, 5000);
			const assertion =
				proposalId === 1
					? expect(finished).resolves.toBeNull()
					: expect(finished).rejects.toThrow("database unavailable");
			worker.resume();
			await assertion;
			if (proposalId === 1) expect(await queues.audit.getJob(job.id!)).toBeUndefined();
			else expect((await queues.audit.getJob(job.id!))?.data.kind.proposalId).toBe(2);
		}
	} finally {
		await worker.close();
		await events.close();
		for (const queue of Object.values(queues)) {
			await queue.obliterate({ force: true });
			await queue.close();
		}
		await connection.quit();
	}
}, 15000);
