import { type Address, isAddress } from "viem";
import { z } from "zod";

const addressSchema = z.string().refine(isAddress, { message: "must be a valid address" });

const envSchema = z.object({
	DISCOVERY_URL: z.string().optional(),
	DISCOVERY_METHOD: z.enum(["orderbook", "aws", "solve"]),
	BYOS_URL: z.string(),
	RPC_URL: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	CHAIN_ID: z.coerce.number().int().positive(),
	TRAMPOLINE_FACTORY: addressSchema,
	FYND_URL: z.string().url().default("http://fynd:3000"),
	FYND_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
	FYND_QUOTE_CONCURRENCY: z.coerce.number().int().positive().default(32),
	FYND_MAX_QUOTE_AGE_SECONDS: z.coerce.number().int().nonnegative().default(10),
	GPV2_SETTLEMENT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	BYOS_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(100),
	BYOS_READ_RESERVE: z.coerce.number().int().nonnegative().default(10),
	PROPOSAL_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
	PROPOSAL_TTL_SECONDS: z.coerce.number().int().positive().default(60),
	POLL_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(2),
	FRESH_ORDER_WINDOW_SECS: z.coerce.number().int().positive().default(4000),
	CLOSE_TO_EXECUTION_TOP_N: z.coerce.number().int().positive().default(20),
	SOLVE_PORT: z.coerce.number().int().positive().default(3001),
	JSON_LOGS: z.enum(["true", "false"]).optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

interface BaseConfig {
	discoveryUrl: string;
	byosUrl: string;
	rpcUrl: string;
	privateKey: `0x${string}`;
	logLevel: string;
	jsonLogs: boolean;
	chainId: number;
	trampolineFactory: Address;
	fyndUrl: string;
	fyndSlippageBps: number;
	fyndQuoteConcurrency: number;
	fyndMaxQuoteAgeSeconds: number;
	gpv2Settlement: Address;
	byosRequestsPerMinute: number;
	byosReadReserve: number;
	proposalRefreshIntervalSeconds: number;
	proposalTtlSeconds: number;
	pollIntervalSeconds: number;
	freshOrderWindowSecs: number;
	closeToExecutionTopN: number;
}

export type Config =
	| (BaseConfig & { discoveryMethod: "orderbook" })
	| (BaseConfig & { discoveryMethod: "aws" })
	| (BaseConfig & { discoveryMethod: "solve"; solvePort: number });

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues
			.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}
	if (result.data.CHAIN_ID !== 56) throw new Error("Fynd subsolver requires BSC (CHAIN_ID = 56)");
	if (result.data.BYOS_READ_RESERVE >= result.data.BYOS_REQUESTS_PER_MINUTE) {
		throw new Error("BYOS_READ_RESERVE must be lower than BYOS_REQUESTS_PER_MINUTE");
	}
	if (result.data.DISCOVERY_METHOD !== "solve" && !result.data.DISCOVERY_URL) {
		throw new Error("DISCOVERY_URL is required for orderbook and aws discovery methods");
	}
	const base = {
		discoveryUrl: result.data.DISCOVERY_URL ?? "",
		byosUrl: result.data.BYOS_URL,
		rpcUrl: result.data.RPC_URL,
		privateKey: result.data.SUBSOLVER_PRIVATE_KEY as `0x${string}`,
		logLevel: result.data.LOG_LEVEL,
		jsonLogs:
			result.data.JSON_LOGS === "true" ||
			(result.data.JSON_LOGS === undefined && env.NODE_ENV === "production"),
		chainId: result.data.CHAIN_ID,
		trampolineFactory: result.data.TRAMPOLINE_FACTORY as Address,
		fyndUrl: result.data.FYND_URL,
		fyndSlippageBps: result.data.FYND_SLIPPAGE_BPS,
		fyndQuoteConcurrency: result.data.FYND_QUOTE_CONCURRENCY,
		fyndMaxQuoteAgeSeconds: result.data.FYND_MAX_QUOTE_AGE_SECONDS,
		gpv2Settlement: result.data.GPV2_SETTLEMENT as Address,
		byosRequestsPerMinute: result.data.BYOS_REQUESTS_PER_MINUTE,
		byosReadReserve: result.data.BYOS_READ_RESERVE,
		proposalRefreshIntervalSeconds: result.data.PROPOSAL_REFRESH_INTERVAL_SECONDS,
		proposalTtlSeconds: result.data.PROPOSAL_TTL_SECONDS,
		pollIntervalSeconds: result.data.POLL_INTERVAL_SECONDS,
		freshOrderWindowSecs: result.data.FRESH_ORDER_WINDOW_SECS,
		closeToExecutionTopN: result.data.CLOSE_TO_EXECUTION_TOP_N,
	};
	if (result.data.DISCOVERY_METHOD === "aws") {
		return { ...base, discoveryMethod: "aws" as const };
	}
	if (result.data.DISCOVERY_METHOD === "solve") {
		return { ...base, discoveryMethod: "solve" as const, solvePort: result.data.SOLVE_PORT };
	}
	return { ...base, discoveryMethod: "orderbook" as const };
}
