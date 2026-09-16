import type { Address, Hex } from "viem";
import { z } from "zod";

const envSchema = z.object({
	BYOS_URL: z.string(),
	ORDERBOOK_URL: z.string(),
	RPC_URL: z.string().url(),
	SETTLEMENT_ADDRESS: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	USDC_ADDRESS: z.string(),
	USDT_ADDRESS: z.string(),
	CHAIN_ID: z.string(),
	TRAMPOLINE_FACTORY: z.string(),
	// Default 240s (4 min) stays within BYOS's default MAX_PROPOSAL_LIFETIME_SECS=300.
	// Proposals with validUntil more than MAX_PROPOSAL_LIFETIME_SECS in the future
	// are rejected at ingestion (ADR-0013).
	MAX_PROPOSAL_LIFETIME_MS: z.string().default("240000"),
	FORCED_SURPLUS: z.string().regex(/^\d+$/, "Must be a decimal integer").default("0"),
	ORDERBOOK_POLL_INTERVAL_MS: z.string().default("2000"),
	PROPOSAL_SYNC_INTERVAL_MS: z.string().default("10000"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
	LOG_PRETTY: z.string().default("false"),
});

export interface Config {
	byosUrl: string;
	orderbookUrl: string;
	rpcUrl: string;
	settlementAddress: Address;
	privateKey: Hex;
	usdcAddress: Address;
	usdtAddress: Address;
	chainId: number;
	trampolineFactory: Address;
	maxProposalLifetimeSecs: bigint;
	orderbookPollIntervalMs: number;
	proposalSyncIntervalMs: number;
	logLevel: string;
	logPretty: boolean;
	forcedSurplus: bigint;
}

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}
	const data = result.data;
	return {
		byosUrl: data.BYOS_URL,
		orderbookUrl: data.ORDERBOOK_URL,
		rpcUrl: data.RPC_URL,
		settlementAddress: data.SETTLEMENT_ADDRESS as Address,
		privateKey: data.SUBSOLVER_PRIVATE_KEY as Hex,
		usdcAddress: data.USDC_ADDRESS as Address,
		usdtAddress: data.USDT_ADDRESS as Address,
		chainId: Number(data.CHAIN_ID),
		trampolineFactory: data.TRAMPOLINE_FACTORY as Address,
		maxProposalLifetimeSecs: BigInt(Math.floor(Number(data.MAX_PROPOSAL_LIFETIME_MS) / 1000)),
		orderbookPollIntervalMs: Number(data.ORDERBOOK_POLL_INTERVAL_MS),
		proposalSyncIntervalMs: Number(data.PROPOSAL_SYNC_INTERVAL_MS),
		logLevel: data.LOG_LEVEL,
		logPretty: data.LOG_PRETTY === "true",
		forcedSurplus: BigInt(data.FORCED_SURPLUS),
	};
}
