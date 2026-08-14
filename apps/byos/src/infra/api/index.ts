import { Hono } from "hono";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { GasPriceRef } from "../blockchain/escrow.js";
import { errorHandler } from "./error.js";
import { bearerAuth } from "./middleware.js";
import { createNotifyRoute } from "./notify.js";
import { createPublicRoutes } from "./routes.js";
import { createSolveRoute } from "./solve.js";

export interface AppContext {
	db: Db;
	chainId: number;
	trampolineFactory: Address;
	maxProposalLifetimeSecs: number;
	cL?: bigint;
	gasPriceRef: GasPriceRef;
	solveBearerToken?: string;
	onAuditEvent: (event: AuditEvent) => void;
	logger?: Logger;
}

/** Creates the public Hono app (sub-solver facing, port 9585). */
export function createPublicApp(ctx: AppContext): Hono {
	const app = new Hono();
	app.onError(errorHandler);

	const routes = createPublicRoutes({
		db: ctx.db,
		chainId: ctx.chainId,
		trampolineFactory: ctx.trampolineFactory,
		maxProposalLifetimeSecs: ctx.maxProposalLifetimeSecs,
		cL: ctx.cL ?? 0n,
		onAuditEvent: ctx.onAuditEvent,
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
