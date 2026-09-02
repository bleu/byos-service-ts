import type { Address, Hex } from "viem";
import { z } from "zod";

const envSchema = z.object({
	BYOS_URL: z.string(),
	ORDERBOOK_URL: z.string(),
	SETTLEMENT_ADDRESS: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	USDC_ADDRESS: z.string(),
	USDT_ADDRESS: z.string(),
	/** Raw token amount (e.g. "50000000" for 50 USDC with 6 decimals) */
	USDC_BALANCE: z.string(),
	/** Raw token amount (e.g. "50000000" for 50 USDT with 6 decimals) */
	USDT_BALANCE: z.string(),
	CHAIN_ID: z.string(),
	TRAMPOLINE_FACTORY: z.string(),
	MAX_PROPOSAL_LIFETIME_MS: z.string().default("600000"),
	ORDERBOOK_POLL_INTERVAL_MS: z.string().default("2000"),
	PROPOSAL_SYNC_INTERVAL_MS: z.string().default("10000"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export interface Config {
	byosUrl: string;
	orderbookUrl: string;
	settlementAddress: Address;
	privateKey: Hex;
	usdcAddress: Address;
	usdtAddress: Address;
	usdcBalance: bigint;
	usdtBalance: bigint;
	chainId: number;
	trampolineFactory: Address;
	maxProposalLifetimeSecs: bigint;
	orderbookPollIntervalMs: number;
	proposalSyncIntervalMs: number;
	logLevel: string;
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
		settlementAddress: data.SETTLEMENT_ADDRESS as Address,
		privateKey: data.SUBSOLVER_PRIVATE_KEY as Hex,
		usdcAddress: data.USDC_ADDRESS as Address,
		usdtAddress: data.USDT_ADDRESS as Address,
		usdcBalance: BigInt(data.USDC_BALANCE),
		usdtBalance: BigInt(data.USDT_BALANCE),
		chainId: Number(data.CHAIN_ID),
		trampolineFactory: data.TRAMPOLINE_FACTORY as Address,
		maxProposalLifetimeSecs: BigInt(Math.floor(Number(data.MAX_PROPOSAL_LIFETIME_MS) / 1000)),
		orderbookPollIntervalMs: Number(data.ORDERBOOK_POLL_INTERVAL_MS),
		proposalSyncIntervalMs: Number(data.PROPOSAL_SYNC_INTERVAL_MS),
		logLevel: data.LOG_LEVEL,
	};
}
