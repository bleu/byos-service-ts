import { z } from "zod";

export const configSchema = z.object({
	// Required
	DATABASE_URL: z.string(),
	REDIS_URL: z.string().default("redis://localhost:6379"),
	CHAIN_ID: z.coerce.number(),
	TRAMPOLINE_FACTORY: z
		.string()
		.regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid 0x-prefixed address"),

	// Listeners
	PUBLIC_ADDR_PORT: z.coerce.number().default(9585),
	INTERNAL_ADDR_PORT: z.coerce.number().default(9586),

	// Auth
	SOLVE_BEARER_TOKEN: z.string().optional(),

	// Chain connectivity (all required together when RPC_URL is set)
	RPC_URL: z.string().optional(),
	ORDERBOOK_URL: z.string().optional(),
	ESCROW_ADDRESS: z.string().optional(),
	SETTLEMENT_ADDRESS: z.string().optional(),
	MIN_COLLATERAL: z.string().optional(),
	DEFAULT_GAS_PRICE: z.string().optional(),

	// Timing
	VALIDATION_INTERVAL_SECS: z.coerce.number().default(12),
	DROPPED_RETENTION_SECS: z.coerce.number().default(3600),
	RETENTION_SWEEP_INTERVAL_SECS: z.coerce.number().default(300),
	MAX_PROPOSAL_LIFETIME_SECS: z.coerce.number().default(300),
	EXECUTING_TIMEOUT_SECS: z.coerce.number().default(300),
	MIN_PROPOSAL_SCORE: z.string().default("0"),

	// Operator (Track A penalty loop)
	OPERATOR_PRIVATE_KEY: z.string().optional(),

	// Logging
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
	JSON_LOGS: z
		.string()
		.transform((v) => v === "true")
		.default("false"),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
	const result = configSchema.safeParse(env);
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
