import "dotenv/config";
import { Redis } from "ioredis";
import { createQueues } from "./infra/jobs/index.js";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--apply") || args.length > 1) {
		throw new Error("Usage: redis-history [--apply]");
	}
	const url = process.env.REDIS_URL;
	if (!url) throw new Error("REDIS_URL is required");
	const apply = args.includes("--apply");
	const connection = new Redis(url, {
		maxRetriesPerRequest: 1,
		connectTimeout: 5000,
		commandTimeout: 10000,
	});
	connection.on("error", () => {}); // Errors are reported by the awaited command below.
	const queues = createQueues(connection);
	try {
		console.info(
			JSON.stringify({
				mode: apply ? "cleanup" : "inspect",
				memory: await connection.info("memory"),
			}),
		);
		for (const queue of Object.values(queues)) {
			const before = await queue.getJobCounts(
				"completed",
				"failed",
				"waiting",
				"active",
				"delayed",
				"paused",
			);
			console.info(JSON.stringify({ queue: queue.name, before }));
			if (!apply) continue;
			// Only completed jobs older than one hour. Failed audit events and all
			// pending work survive. Bound each Lua call and the total work to the
			// initial count so a live producer cannot keep this command running forever.
			let removed = 0;
			for (let remaining = before.completed ?? 0; remaining > 0; ) {
				const batchSize = Math.min(100, remaining);
				const batch = await queue.clean(3600_000, batchSize, "completed");
				removed += batch.length;
				remaining -= batchSize;
				if (batch.length < batchSize) break;
			}
			console.info(
				JSON.stringify({
					queue: queue.name,
					removedCompleted: removed,
					after: await queue.getJobCounts(),
				}),
			);
		}
	} finally {
		await Promise.all(Object.values(queues).map((queue) => queue.close()));
		connection.disconnect();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Redis history inspection failed");
	process.exitCode = 1;
});
