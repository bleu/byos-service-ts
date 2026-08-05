import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { Address, Hex } from "viem";
import { z } from "zod";

const envSchema = z.object({
	ORDERBOOK_URL: z.string(),
	BYOS_URL: z.string(),
	RPC_URL: z.string(),
	SUBSOLVER_PRIVATE_KEY: z.string(),
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

	return {
		orderBookUrl: result.data.ORDERBOOK_URL,
		byosUrl: result.data.BYOS_URL,
		rpcUrl: result.data.RPC_URL,
		privateKey: result.data.SUBSOLVER_PRIVATE_KEY as Hex,
		logLevel: result.data.LOG_LEVEL,
		toml,
	};
}
