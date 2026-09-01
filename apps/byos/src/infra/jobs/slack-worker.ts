import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface SlackNotificationPayload {
	text: string;
}

/** Posts a message to the configured Slack webhook URL. */
async function postToSlack(webhookUrl: string, text: string): Promise<void> {
	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (!res.ok) {
		throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
	}
}

/** Creates a BullMQ worker that sends Slack notifications. */
export function createSlackWorker(
	connection: Redis,
	webhookUrl: string,
	logger: Logger,
): Worker {
	return new Worker(
		"slack-notification",
		async (job) => {
			const { text } = job.data as SlackNotificationPayload;
			await postToSlack(webhookUrl, text);
		},
		{
			connection,
			prefix: "byos",
			concurrency: 1,
		},
	);
}

/** Enqueues a Slack notification. Fire-and-forget with retries. */
export async function enqueueSlackNotification(
	queue: import("bullmq").Queue,
	text: string,
): Promise<void> {
	await queue.add(
		"slack-notify",
		{ text } satisfies SlackNotificationPayload,
		{
			attempts: 5,
			backoff: { type: "exponential", delay: 2000 },
			removeOnComplete: true,
			removeOnFail: false,
		},
	);
}
