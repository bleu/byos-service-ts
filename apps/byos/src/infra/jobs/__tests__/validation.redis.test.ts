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
		// Set up the completion listener BEFORE enqueueing — the worker is now
		// unblocked and could finish the second job before waitUntilFinished
		// registers its listener, causing a "Missing key" error from BullMQ.
		const secondJobDone = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("second job timed out")), 5000);
			events.once("completed", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		await enqueueProposalValidation(queue, 123);
		await secondJobDone;
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
