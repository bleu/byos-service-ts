import { Hono } from "hono";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { BalanceCache } from "../../domain/balance-cache.js";
import { unknownBalances } from "../../domain/balance-cache.js";
import type { RateLimiter, TierParams } from "../../domain/rate-limit.js";
import { allowAll } from "../../domain/rate-limit.js";
import type { GasPriceRef } from "../blockchain/escrow.js";
import { errorHandler } from "./error.js";
import { bearerAuth, ipRateLimit } from "./middleware.js";
import { createNotifyRoute } from "./notify.js";
import { createPublicRoutes } from "./routes.js";
import { createSolveRoute } from "./solve.js";

/** Rate-limit knobs, all operational tuning parameters (ADR-0015). */
export interface RateLimitSettings {
	windowSecs: number;
	ipPerWindow: number;
	tier: TierParams;
	/** Escrow floor below which a known signer is rejected synchronously. */
	floorWei: bigint;
}

export interface AppContext {
	db: Db;
	chainId: number;
	trampolineFactory: Address;
	maxProposalLifetimeSecs: number;
	cL: bigint;
	gasPriceRef: GasPriceRef;
	solveBearerToken?: string;
	onAuditEvent: (event: AuditEvent) => void;
	logger?: Logger;
}

/**
 * What the public listener needs on top of the shared context. The internal
 * listener is driver-facing and never rate limited, so it does not carry these.
 */
export interface PublicAppContext extends AppContext {
	/** Defaults to the allowAll stub, so tests need no Redis. */
	rateLimiter?: RateLimiter;
	/** Defaults to the unknownBalances stub, admitting everyone at the
	 * lowest tier. */
	balances?: BalanceCache;
	/**
	 * Required rather than defaulted. The Zod schema in config.ts owns these
	 * numbers, and a second copy lived here until it drifted from the schema on
	 * `floorWei` inside a single PR. Build one with `rateLimitsFromConfig`.
	 */
	rateLimits: RateLimitSettings;
}

/** Creates the public Hono app (sub-solver facing, port 9585). */
export function createPublicApp(ctx: PublicAppContext): Hono {
	const app = new Hono();
	app.onError(errorHandler);

	const limiter = ctx.rateLimiter ?? allowAll;
	const limits = ctx.rateLimits;

	// Layer 1b only. The primary per-IP limit lives at the Cloudflare edge,
	// and never touches the internal listener, which is latency-critical.
	app.use(
		"*",
		ipRateLimit({
			limiter,
			limit: limits.ipPerWindow,
			windowSecs: limits.windowSecs,
			exemptPaths: ["/healthz"],
			logger: ctx.logger,
		}),
	);

	const routes = createPublicRoutes({
		db: ctx.db,
		chainId: ctx.chainId,
		trampolineFactory: ctx.trampolineFactory,
		maxProposalLifetimeSecs: ctx.maxProposalLifetimeSecs,
		cL: ctx.cL,
		onAuditEvent: ctx.onAuditEvent,
		signerLimit: {
			limiter,
			balances: ctx.balances ?? unknownBalances,
			tier: limits.tier,
			windowSecs: limits.windowSecs,
			floorWei: limits.floorWei,
			logger: ctx.logger,
		},
	});

	app.route("/", routes);
	return app;
}

/** Creates the internal Hono app (driver facing, port 9586). */
export function createInternalApp(ctx: AppContext): Hono {
	const app = new Hono();
	app.onError(errorHandler);

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	const solve = createSolveRoute({
		db: ctx.db,
		gasPriceRef: ctx.gasPriceRef,
		onAuditEvent: ctx.onAuditEvent,
	});

	const notify = createNotifyRoute({
		db: ctx.db,
		onAuditEvent: ctx.onAuditEvent,
		logger: ctx.logger,
	});

	// Apply bearer auth if configured
	if (ctx.solveBearerToken) {
		const auth = bearerAuth(ctx.solveBearerToken);
		app.use("/solve", auth);
		app.use("/notify", auth);
	}

	app.route("/", solve);
	app.route("/", notify);

	return app;
}
