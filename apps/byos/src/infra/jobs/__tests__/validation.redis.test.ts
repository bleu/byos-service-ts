import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { expect, it } from "vitest";
import { enqueueProposalValidation } from "../validation.js";

it("deduplicates ingestion and tick dispatch while validation is running", async () => {
	const connection = new Redis(process.env.BYOS_TEST_REDIS_URL ?? "redis://localhost:6379", {
		maxRetriesPerRequest: null,
	});
	const name = `validation-test-${randomUUID()}`;
	const queue = new Queue(name, { connection });
	const events = new QueueEvents(name, { connection });
	let release!: () => void;
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const worker = new Worker(
		name,
		async () => {
			calls++;
			started();
			await blocked;
		},
		{ connection, concurrency: 4 },
	);
	try {
		await events.waitUntilReady();
		await enqueueProposalValidation(queue, 123);
		const job = await queue.getJob("proposal-123");
		if (!job) throw new Error("missing validation job");
		const completed = job.waitUntilFinished(events, 5000);
		await running;
		await Promise.all(Array.from({ length: 10 }, () => enqueueProposalValidation(queue, 123)));
		release();
		await completed;
		expect(calls).toBe(1);
		// The refresh is immediately runnable: pause until completion observation
		// is registered, or removeOnComplete can delete it before isFinished.
		await worker.pause();
		await enqueueProposalValidation(queue, 123);
		const refresh = await queue.getJob("proposal-123");
		if (!refresh) throw new Error("missing refresh job");
		const refreshed = refresh.waitUntilFinished(events, 5000);
		worker.resume();
		await refreshed;
		expect(calls).toBe(2);
	} finally {
		release();
		await worker.close();
		await events.close();
		await queue.obliterate({ force: true });
		await queue.close();
		await connection.quit();
	}
}, 10000);
