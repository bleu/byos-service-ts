import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface SlackNotificationPayload {
	text: string;
}

/** Posts a message to a Slack channel via the Web API. */
export async function postToSlack(token: string, channel: string, text: string): Promise<void> {
	const res = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ channel, text, unfurl_links: false }),
	});
	if (!res.ok) {
		throw new Error(`Slack API returned ${res.status}: ${await res.text()}`);
	}
	const data = (await res.json()) as { ok: boolean; error?: string };
	if (!data.ok) {
		throw new Error(`Slack API error: ${data.error}`);
	}
}

/** Creates a BullMQ worker that sends Slack notifications. */
export function createSlackWorker(
	connection: Redis,
	token: string,
	channel: string,
	logger: Logger,
): Worker {
	return new Worker(
		"slack-notification",
		async (job) => {
			const { text } = job.data as SlackNotificationPayload;
			await postToSlack(token, channel, text);
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
