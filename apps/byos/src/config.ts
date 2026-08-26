import { isSupportedEvmChain } from "@byos/common";
import { z } from "zod";
import type { RateLimitSettings } from "./infra/api/index.js";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export const configSchema = z.object({
	// Required
	DATABASE_URL: z.string(),
	REDIS_URL: z.string().default("redis://localhost:6379"),
	CHAIN_ID: z.coerce
		.number()
		.int()
		.refine(isSupportedEvmChain, "Must be an EVM chain supported by CoW Protocol"),
	/** TrampolineFactory address for this deployment. Required: BYOS needs it
	 * for EIP-712 domain construction even before an RPC is configured. */
	TRAMPOLINE_FACTORY: z.string().regex(addressPattern, "Must be a valid 0x-prefixed address"),

	// Listeners
	PUBLIC_ADDR_PORT: z.coerce.number().default(9585),
	INTERNAL_ADDR_PORT: z.coerce.number().default(9586),

	// Auth
	SOLVE_BEARER_TOKEN: z.string().optional(),

	// Chain connectivity (RPC_URL is the primary knob; the rest resolve from the chain)
	RPC_URL: z.string().optional(),
	/** Overrides the orderbook URL from `orderbookUrlFor`. Useful for barn/staging. */
	ORDERBOOK_URL: z.string().optional(),
	/** Escrow contract address for this deployment. Required when RPC_URL is set;
	 * set once per chain by the operator who deployed the contract. */
	ESCROW_ADDRESS: z
		.string()
		.regex(addressPattern, "Must be a valid 0x-prefixed address")
		.optional(),
	/** Overrides the settlement address from `settlementAddressFor`. */
	SETTLEMENT_ADDRESS: z
		.string()
		.regex(addressPattern, "Must be a valid 0x-prefixed address")
		.optional(),
	/** Minimum escrow collateral for this deployment, in wei. Defaults to 10^16
	 * (0.01 ETH-equivalent) — a placeholder until per-chain gas data informs it
	 * (COW-1265). Override with MIN_COLLATERAL when deploying. */
	MIN_COLLATERAL: z
		.string()
		.regex(/^\d+$/, "Must be a decimal wei amount")
		.default("10000000000000000"),
	DEFAULT_GAS_PRICE: z.string().optional(),

	// Timing
	VALIDATION_INTERVAL_SECS: z.coerce.number().default(12),
	DROPPED_RETENTION_SECS: z.coerce.number().default(3600),
	RETENTION_SWEEP_INTERVAL_SECS: z.coerce.number().default(300),
	MAX_PROPOSAL_LIFETIME_SECS: z.coerce.number().default(300),
	EXECUTING_TIMEOUT_SECS: z.coerce.number().default(300),
	MIN_PROPOSAL_SCORE: z.string().default("0"),

	// Rate limiting (ADR-0015). All are operational tuning parameters —
	// the defaults are sized from the reference client's poll volume, not
	// from measured traffic. See COW-1265 before going public.
	//
	// Every count and duration here is an integer. Not cosmetic: these reach
	// BigInt() in the tier function and EXPIRE/SET EX/ZREMRANGEBYRANK in
	// Redis, all of which reject a fractional value at runtime rather than
	// at startup.
	RATE_LIMIT_WINDOW_SECS: z.coerce.number().int().positive().default(60),
	/** Loose in-app backstop behind the Cloudflare edge limit. */
	RATE_LIMIT_IP_PER_WINDOW: z.coerce.number().int().positive().default(6000),
	/** Escrow wei that buys one unit of throughput. Never derived from
	 * MIN_COLLATERAL, which may legitimately be "0". */
	RATE_UNIT_WEI: z
		.string()
		.regex(/^\d+$/, "Must be a decimal wei amount")
		.refine((v) => BigInt(v) > 0n, "Must be greater than zero")
		.default("100000000000000000"),
	RATE_PER_UNIT: z.coerce.number().int().positive().default(300),
	RATE_MIN_PER_WINDOW: z.coerce.number().int().positive().default(120),
	RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(3000),

	// Request-path escrow balance cache
	BALANCE_REFRESH_INTERVAL_SECS: z.coerce.number().int().positive().default(60),
	BALANCE_EVICTION_SECS: z.coerce.number().int().positive().default(3600),
	BALANCE_NEGATIVE_TTL_SECS: z.coerce.number().int().positive().default(600),
	/**
	 * Cap on the refresh set. Load-bearing on RPC cost, not just memory: a tick
	 * makes `ceil(cap / BALANCE_REFRESH_BATCH_SIZE)` multicalls back to back, so
	 * at 10000/50 that is 200 requests per tick. Raising it past roughly
	 * `BALANCE_REFRESH_INTERVAL_SECS / per-request latency * batch size` means
	 * the tick cannot finish inside its own interval.
	 */
	BALANCE_ACTIVE_SET_MAX: z.coerce.number().int().positive().default(10_000),
	BALANCE_REFRESH_BATCH_SIZE: z.coerce.number().int().positive().default(50),

	// Operator (Track A penalty loop)
	OPERATOR_PRIVATE_KEY: z.string().optional(),

	// Logging
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
	JSON_LOGS: z
		.string()
		.transform((v) => v === "true")
		.default("false"),
});

/**
 * Mirrors the Rust CLI's requires_all: a half-configured chain connection
 * must fail startup, not boot with a missing value.
 *
 * ESCROW_ADDRESS is required with RPC_URL: there is no per-chain lookup table
 * for BYOS-specific contracts — the operator sets the address for the chain
 * they deployed to.
 */
const RPC_COMPANIONS = ["ESCROW_ADDRESS", "DEFAULT_GAS_PRICE"] as const;

const refinedConfigSchema = configSchema.superRefine((cfg, ctx) => {
	if (cfg.RPC_URL) {
		for (const key of RPC_COMPANIONS) {
			if (!cfg[key]) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: "required when RPC_URL is set",
				});
			}
		}
	}

	if (cfg.RATE_MIN_PER_WINDOW > cfg.RATE_MAX_PER_WINDOW) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["RATE_MIN_PER_WINDOW"],
			message: "must not exceed RATE_MAX_PER_WINDOW",
		});
	}

	if (!cfg.RPC_URL && cfg.OPERATOR_PRIVATE_KEY) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["OPERATOR_PRIVATE_KEY"],
			message: "requires RPC_URL",
		});
	}
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = refinedConfigSchema.safeParse(env);
	if (!result.success) {
		const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid configuration:\n${errors}`);
	}
	return result.data;
}

export function safeConfigForLogging(config: Config): Record<string, unknown> {
	return {
		...config,
		DATABASE_URL: "<redacted>",
		REDIS_URL: "<redacted>",
		RPC_URL: config.RPC_URL ? "<redacted>" : undefined,
		SOLVE_BEARER_TOKEN: config.SOLVE_BEARER_TOKEN ? "<redacted>" : undefined,
		OPERATOR_PRIVATE_KEY: config.OPERATOR_PRIVATE_KEY ? "<redacted>" : undefined,
	};
}

/**
 * Rate limit settings from config. The schema above owns every number, so the
 * app and the tests read them from one place rather than each keeping a copy —
 * a second copy in `infra/api/index.ts` drifted from this one within a single
 * PR, on `floorWei`.
 *
 * `floorWei` is not a config field: it is the resolved collateral floor, which
 * comes from the chain unless MIN_COLLATERAL overrides it.
 */
export function rateLimitsFromConfig(config: Config, floorWei: bigint): RateLimitSettings {
	return {
		windowSecs: config.RATE_LIMIT_WINDOW_SECS,
		ipPerWindow: config.RATE_LIMIT_IP_PER_WINDOW,
		tier: {
			rateUnitWei: BigInt(config.RATE_UNIT_WEI),
			ratePerUnit: config.RATE_PER_UNIT,
			minRate: config.RATE_MIN_PER_WINDOW,
			maxRate: config.RATE_MAX_PER_WINDOW,
		},
		floorWei,
	};
}
