import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { Address } from "viem";
import { z } from "zod";

const envSchema = z.object({
	ORDERBOOK_URL: z.string(),
	BYOS_URL: z.string(),
	RPC_URL: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	FYND_URL: z.string().url().default("http://fynd:3000"),
	FYND_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
	FYND_QUOTE_CONCURRENCY: z.coerce.number().int().positive().default(32),
	FYND_MAX_QUOTE_AGE_SECONDS: z.coerce.number().int().nonnegative().default(10),
	GPV2_SETTLEMENT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	BYOS_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(100),
	BYOS_READ_RESERVE: z.coerce.number().int().nonnegative().default(10),
	PROPOSAL_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
	CONFIG_PATH: z.string().optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export interface Config {
	orderBookUrl: string;
	byosUrl: string;
	rpcUrl: string;
	privateKey: `0x${string}`;
	logLevel: string;
	fyndUrl: string;
	fyndSlippageBps: number;
	fyndQuoteConcurrency: number;
	fyndMaxQuoteAgeSeconds: number;
	gpv2Settlement: Address;
	byosRequestsPerMinute: number;
	byosReadReserve: number;
	proposalRefreshIntervalSeconds: number;
	toml: { chainId: number; trampolineFactory: Address; proposalTtl: number; pollInterval: number };
}

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues
			.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}
	const raw = parse(readFileSync(result.data.CONFIG_PATH ?? "config.toml", "utf-8")) as Record<
		string,
		unknown
	>;
	const chainId = Number(raw["chain-id"] ?? raw.chainId);
	if (chainId !== 56) throw new Error("Fynd subsolver requires BSC (chain-id = 56)");
	if (result.data.BYOS_READ_RESERVE >= result.data.BYOS_REQUESTS_PER_MINUTE) {
		throw new Error("BYOS_READ_RESERVE must be lower than BYOS_REQUESTS_PER_MINUTE");
	}
	return {
		orderBookUrl: result.data.ORDERBOOK_URL,
		byosUrl: result.data.BYOS_URL,
		rpcUrl: result.data.RPC_URL,
		privateKey: result.data.SUBSOLVER_PRIVATE_KEY as `0x${string}`,
		logLevel: result.data.LOG_LEVEL,
		fyndUrl: result.data.FYND_URL,
		fyndSlippageBps: result.data.FYND_SLIPPAGE_BPS,
		fyndQuoteConcurrency: result.data.FYND_QUOTE_CONCURRENCY,
		fyndMaxQuoteAgeSeconds: result.data.FYND_MAX_QUOTE_AGE_SECONDS,
		gpv2Settlement: result.data.GPV2_SETTLEMENT as Address,
		byosRequestsPerMinute: result.data.BYOS_REQUESTS_PER_MINUTE,
		byosReadReserve: result.data.BYOS_READ_RESERVE,
		proposalRefreshIntervalSeconds: result.data.PROPOSAL_REFRESH_INTERVAL_SECONDS,
		toml: {
			chainId,
			trampolineFactory: (raw["trampoline-factory"] ?? raw.trampolineFactory) as Address,
			proposalTtl: Number(raw["proposal-ttl-secs"] ?? raw.proposalTtl ?? 60),
			pollInterval: Number(raw["poll-interval-secs"] ?? raw.pollInterval ?? 2),
		},
	};
}
