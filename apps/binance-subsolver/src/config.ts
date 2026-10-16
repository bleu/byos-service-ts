import { type Address, isAddress } from "viem";
import { z } from "zod";

const addressSchema = z.string().refine(isAddress, { message: "must be a valid address" });

const envSchema = z.object({
	ORDERBOOK_URL: z.string(),
	BYOS_URL: z.string(),
	RPC_URL: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	CHAIN_ID: z.coerce.number().int().positive(),
	TRAMPOLINE_FACTORY: addressSchema,
	BINANCE_API_KEY: z.string(),
	BINANCE_SECRET_KEY: z.string(),
	GPV2_SETTLEMENT: addressSchema,
	BINANCE_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
	BINANCE_QUOTE_CONCURRENCY: z.coerce.number().int().positive().default(32),
	BYOS_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(100),
	BYOS_READ_RESERVE: z.coerce.number().int().nonnegative().default(10),
	PROPOSAL_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
	PROPOSAL_TTL_SECONDS: z.coerce.number().int().positive().default(60),
	POLL_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(2),
	JSON_LOGS: z.enum(["true", "false"]).optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export interface Config {
	orderBookUrl: string;
	byosUrl: string;
	rpcUrl: string;
	privateKey: `0x${string}`;
	logLevel: string;
	jsonLogs: boolean;
	chainId: number;
	trampolineFactory: Address;
	binanceApiKey: string;
	binanceSecretKey: string;
	gpv2Settlement: Address;
	binanceSlippageBps: number;
	binanceQuoteConcurrency: number;
	byosRequestsPerMinute: number;
	byosReadReserve: number;
	proposalRefreshIntervalSeconds: number;
	proposalTtlSeconds: number;
	pollIntervalSeconds: number;
}

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues
			.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}
	if (result.data.BYOS_READ_RESERVE >= result.data.BYOS_REQUESTS_PER_MINUTE) {
		throw new Error("BYOS_READ_RESERVE must be lower than BYOS_REQUESTS_PER_MINUTE");
	}
	return {
		orderBookUrl: result.data.ORDERBOOK_URL,
		byosUrl: result.data.BYOS_URL,
		rpcUrl: result.data.RPC_URL,
		privateKey: result.data.SUBSOLVER_PRIVATE_KEY as `0x${string}`,
		logLevel: result.data.LOG_LEVEL,
		jsonLogs:
			result.data.JSON_LOGS === "true" ||
			(result.data.JSON_LOGS === undefined && env.NODE_ENV === "production"),
		chainId: result.data.CHAIN_ID,
		trampolineFactory: result.data.TRAMPOLINE_FACTORY as Address,
		binanceApiKey: result.data.BINANCE_API_KEY,
		binanceSecretKey: result.data.BINANCE_SECRET_KEY,
		gpv2Settlement: result.data.GPV2_SETTLEMENT as Address,
		binanceSlippageBps: result.data.BINANCE_SLIPPAGE_BPS,
		binanceQuoteConcurrency: result.data.BINANCE_QUOTE_CONCURRENCY,
		byosRequestsPerMinute: result.data.BYOS_REQUESTS_PER_MINUTE,
		byosReadReserve: result.data.BYOS_READ_RESERVE,
		proposalRefreshIntervalSeconds: result.data.PROPOSAL_REFRESH_INTERVAL_SECONDS,
		proposalTtlSeconds: result.data.PROPOSAL_TTL_SECONDS,
		pollIntervalSeconds: result.data.POLL_INTERVAL_SECONDS,
	};
}
