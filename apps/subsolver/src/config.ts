import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { Address, Hex } from "viem";
import { z } from "zod";

const envSchema = z.object({
	ORDERBOOK_URL: z.string(),
	BYOS_URL: z.string(),
	RPC_URL: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
	SUBSOLVER_PROVIDER: z.enum(["baseline", "fynd"]).default("baseline"),
	FYND_URL: z.string().url().optional(),
	FYND_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
	FYND_QUOTE_CONCURRENCY: z.coerce.number().int().positive().default(32),
	FYND_MAX_QUOTE_AGE_SECONDS: z.coerce.number().int().nonnegative().default(10),
	GPV2_SETTLEMENT: z
		.string()
		.regex(/^0x[0-9a-fA-F]{40}$/)
		.optional(),
	BYOS_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(100),
	BYOS_READ_RESERVE: z.coerce.number().int().nonnegative().default(10),
	PROPOSAL_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
	CONFIG_PATH: z.string().optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export interface TomlConfig {
	chainId: number;
	trampolineFactory: Address;
	uniswapRouter: Address;
	uniswapFactory: Address;
	pairInitCodeHash: Hex;
	proposalTtl: number;
	pollInterval: number;
	appendRevert: boolean;
}

export interface Config {
	orderBookUrl: string;
	byosUrl: string;
	rpcUrl: string;
	privateKey: Hex;
	logLevel: string;
	provider: "baseline" | "fynd";
	fyndUrl?: string;
	fyndSlippageBps: number;
	fyndQuoteConcurrency: number;
	fyndMaxQuoteAgeSeconds: number;
	gpv2Settlement?: Address;
	byosRequestsPerMinute: number;
	byosReadReserve: number;
	proposalRefreshIntervalSeconds: number;
	toml: TomlConfig;
}

function loadToml(path: string): TomlConfig {
	const content = readFileSync(path, "utf-8");
	const raw = parse(content) as Record<string, unknown>;

	return {
		chainId: Number(raw["chain-id"] ?? raw.chainId),
		trampolineFactory: (raw["trampoline-factory"] ?? raw.trampolineFactory) as Address,
		uniswapRouter: (raw["uniswap-router"] ?? raw.uniswapRouter) as Address,
		uniswapFactory: (raw["uniswap-factory"] ?? raw.uniswapFactory) as Address,
		pairInitCodeHash: (raw["pair-init-code-hash"] ?? raw.pairInitCodeHash) as Hex,
		proposalTtl: Number(raw["proposal-ttl-secs"] ?? raw.proposalTtl ?? 60),
		pollInterval: Number(raw["poll-interval-secs"] ?? raw.pollInterval ?? 2),
		appendRevert: Boolean(raw["append-revert"] ?? raw.appendRevert ?? false),
	};
}

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}

	const configPath = result.data.CONFIG_PATH ?? "config.toml";
	const toml = loadToml(configPath);
	if (result.data.SUBSOLVER_PROVIDER === "fynd" && toml.chainId !== 56) {
		throw new Error("Fynd provider requires BSC (chain-id = 56)");
	}
	if (result.data.SUBSOLVER_PROVIDER === "fynd" && !result.data.GPV2_SETTLEMENT) {
		throw new Error("Fynd provider requires GPV2_SETTLEMENT");
	}
	if (result.data.BYOS_READ_RESERVE >= result.data.BYOS_REQUESTS_PER_MINUTE) {
		throw new Error("BYOS_READ_RESERVE must be lower than BYOS_REQUESTS_PER_MINUTE");
	}

	return {
		orderBookUrl: result.data.ORDERBOOK_URL,
		byosUrl: result.data.BYOS_URL,
		rpcUrl: result.data.RPC_URL,
		privateKey: result.data.SUBSOLVER_PRIVATE_KEY as Hex,
		logLevel: result.data.LOG_LEVEL,
		provider: result.data.SUBSOLVER_PROVIDER,
		fyndUrl: result.data.FYND_URL,
		fyndSlippageBps: result.data.FYND_SLIPPAGE_BPS,
		fyndQuoteConcurrency: result.data.FYND_QUOTE_CONCURRENCY,
		fyndMaxQuoteAgeSeconds: result.data.FYND_MAX_QUOTE_AGE_SECONDS,
		gpv2Settlement: result.data.GPV2_SETTLEMENT as Address | undefined,
		byosRequestsPerMinute: result.data.BYOS_REQUESTS_PER_MINUTE,
		byosReadReserve: result.data.BYOS_READ_RESERVE,
		proposalRefreshIntervalSeconds: result.data.PROPOSAL_REFRESH_INTERVAL_SECONDS,
		toml,
	};
}
