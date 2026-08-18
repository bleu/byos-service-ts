import { z } from "zod";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export const configSchema = z.object({
	// Required
	DATABASE_URL: z.string(),
	REDIS_URL: z.string().default("redis://localhost:6379"),
	CHAIN_ID: z.coerce.number(),
	TRAMPOLINE_FACTORY: z.string().regex(addressPattern, "Must be a valid 0x-prefixed address"),

	// Listeners
	PUBLIC_ADDR_PORT: z.coerce.number().default(9585),
	INTERNAL_ADDR_PORT: z.coerce.number().default(9586),

	// Auth
	SOLVE_BEARER_TOKEN: z.string().optional(),

	// Chain connectivity (all required together when RPC_URL is set)
	RPC_URL: z.string().optional(),
	ORDERBOOK_URL: z.string().optional(),
	ESCROW_ADDRESS: z
		.string()
		.regex(addressPattern, "Must be a valid 0x-prefixed address")
		.optional(),
	SETTLEMENT_ADDRESS: z
		.string()
		.regex(addressPattern, "Must be a valid 0x-prefixed address")
		.optional(),
	MIN_COLLATERAL: z.string().optional(),
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
	RATE_LIMIT_WINDOW_SECS: z.coerce.number().positive().default(60),
	/** Loose in-app backstop behind the Cloudflare edge limit. */
	RATE_LIMIT_IP_PER_WINDOW: z.coerce.number().positive().default(6000),
	/** Escrow wei that buys one unit of throughput. Never derived from
	 * MIN_COLLATERAL, which may legitimately be "0". */
	RATE_UNIT_WEI: z
		.string()
		.regex(/^\d+$/, "Must be a decimal wei amount")
		.refine((v) => BigInt(v) > 0n, "Must be greater than zero")
		.default("100000000000000000"),
	RATE_PER_UNIT: z.coerce.number().positive().default(300),
	RATE_MIN_PER_WINDOW: z.coerce.number().positive().default(120),
	RATE_MAX_PER_WINDOW: z.coerce.number().positive().default(3000),

	// Request-path escrow balance cache
	BALANCE_REFRESH_INTERVAL_SECS: z.coerce.number().positive().default(60),
	BALANCE_EVICTION_SECS: z.coerce.number().positive().default(3600),
	BALANCE_NEGATIVE_TTL_SECS: z.coerce.number().positive().default(600),
	BALANCE_ACTIVE_SET_MAX: z.coerce.number().positive().default(100_000),
	BALANCE_REFRESH_BATCH_SIZE: z.coerce.number().positive().default(50),

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
 * must fail startup, not boot with an undefined escrow address or a
 * collateral floor of zero.
 */
const RPC_COMPANIONS = [
	"ORDERBOOK_URL",
	"ESCROW_ADDRESS",
	"SETTLEMENT_ADDRESS",
	"MIN_COLLATERAL",
	"DEFAULT_GAS_PRICE",
] as const;

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
