import {
	byosDomain,
	createProposalRequestSchema,
	recoverCanceller,
	recoverProposer,
	recoverReader,
} from "@byos/common";
import { Hono } from "hono";
import type { Address } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import * as store from "../storage.js";
import {
	parseCreateProposalRequest,
	proposalToGetResponse,
	proposalToListResponse,
} from "./dto.js";
import { AppError, Kind } from "./error.js";
import { enforceSignerLimit, extractSignature, type SignerLimitConfig } from "./middleware.js";

export interface RoutesConfig {
	db: Db;
	chainId: number;
	trampolineFactory: Address;
	maxProposalLifetimeSecs: number;
	onAuditEvent: (event: AuditEvent) => void;
	signerLimit: SignerLimitConfig;
}

export function createPublicRoutes(config: RoutesConfig) {
	const app = new Hono();
	const domain = byosDomain(config.chainId, config.trampolineFactory);

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	// POST /proposals — Create proposal
	app.post("/proposals", async (c) => {
		const rawBody = await c.req.json();
		const parseResult = createProposalRequestSchema.safeParse(rawBody);
		if (!parseResult.success) {
			// Per-field description, as Rust's edge parsers report.
			const path = parseResult.error.issues[0]?.path.join(".");
			throw new AppError(Kind.BadRequest, path ? `invalid ${path}` : "Malformed request");
		}

		const body = parseResult.data;

		// The schema pins the hex grammar; the shape of a signature (exactly
		// 65 bytes) is its own failure kind, as in Rust's Signature::try_from.
		const signatureDigits = body.signature.startsWith("0x")
			? body.signature.length - 2
			: body.signature.length;
		if (signatureDigits !== 130) {
			throw new AppError(Kind.InvalidSignature);
		}

		let parsed: ReturnType<typeof parseCreateProposalRequest>;
		try {
			parsed = parseCreateProposalRequest(body);
		} catch {
			throw new AppError(Kind.BadRequest, "Failed to parse proposal fields");
		}

		// Recover sub-solver from EIP-712 signature
		let subSolver: Address;
		try {
			subSolver = await recoverProposer(
				parsed.signature,
				domain,
				{
					orderUidHash: parsed.orderUidHash,
					sellAmount: parsed.sellAmount,
					buyAmount: parsed.buyAmount,
					validUntil: parsed.validUntil,
					nonce: parsed.nonce,
				},
				parsed.interactionsHash,
			);
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, subSolver);

		// Validate expiry
		const now = BigInt(Math.floor(Date.now() / 1000));
		if (parsed.validUntil <= now) {
			throw new AppError(Kind.ProposalExpired);
		}
		if (parsed.validUntil > now + BigInt(config.maxProposalLifetimeSecs)) {
			throw new AppError(Kind.ProposalLifetimeExceeded);
		}

		// Insert as Submitted
		const { id, auditEvent } = await store.insert(config.db, {
			subSolver,
			orderUid: parsed.orderUid,
			orderUidHash: parsed.orderUidHash,
			sellAmount: parsed.sellAmount,
			buyAmount: parsed.buyAmount,
			sellToken: "0x0000000000000000000000000000000000000000" as Address, // Set by validator
			buyToken: "0x0000000000000000000000000000000000000000" as Address,
			interactions: parsed.interactions,
			interactionsHash: parsed.interactionsHash,
			validUntil: parsed.validUntil,
			nonce: parsed.nonce,
			signature: parsed.signature,
			status: "submitted",
			rejectionReason: null,
			gasUsed: null,
			trampoline: null,
			settlementTxHash: null,
			penaltyTxHash: null,
			pendingCancellation: false,
		});

		config.onAuditEvent(auditEvent);
		return c.json({ id }, 202);
	});

	// GET /proposal/:id — Get single proposal (owner-scoped)
	app.get("/proposal/:id", async (c) => {
		// Not just NaN: Number("1.5") and Number("1e30") both parse, then fail in
		// the driver as a 500 for what is a malformed id.
		const id = Number(c.req.param("id"));
		if (!Number.isSafeInteger(id) || id < 0) {
			throw new AppError(Kind.BadRequest, "Invalid proposal id");
		}

		const sig = extractSignature(c);
		let reader: Address;
		try {
			reader = await recoverReader(sig, domain);
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, reader);

		const result = await store.getForOwner(config.db, id, reader);
		if ("kind" in result) {
			// notFound or notOwner → 404 (no existence oracle, ADR-0011)
			throw new AppError(Kind.ProposalNotFound);
		}

		return c.json(proposalToGetResponse(result));
	});

	// GET /proposals/by-sub-solver — List by sub-solver (owner-scoped)
	app.get("/proposals/by-sub-solver", async (c) => {
		const sig = extractSignature(c);
		let reader: Address;
		try {
			reader = await recoverReader(sig, domain);
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, reader);

		const proposals = await store.listBySubSolver(config.db, reader);
		return c.json(proposalToListResponse(proposals));
	});

	// GET /proposals/:orderUid — List by order UID (owner-scoped)
	app.get("/proposals/:orderUid", async (c) => {
		const orderUid = c.req.param("orderUid");
		const sig = extractSignature(c);
		let reader: Address;
		try {
			reader = await recoverReader(sig, domain);
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, reader);

		const proposals = await store.listByOrderUidForOwner(config.db, orderUid, reader);
		return c.json(proposalToListResponse(proposals));
	});

	// DELETE /proposal/:id — Cancel proposal
	app.delete("/proposal/:id", async (c) => {
		// Not just NaN: Number("1.5") and Number("1e30") both parse, then fail in
		// the driver as a 500 for what is a malformed id.
		const id = Number(c.req.param("id"));
		if (!Number.isSafeInteger(id) || id < 0) {
			throw new AppError(Kind.BadRequest, "Invalid proposal id");
		}

		const sig = extractSignature(c);
		let canceller: Address;
		try {
			canceller = await recoverCanceller(sig, domain, BigInt(id));
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, canceller);

		const result = await store.cancel(config.db, id, canceller);
		if ("kind" in result) {
			switch (result.kind) {
				case "notFound":
				case "notOwner":
					throw new AppError(Kind.ProposalNotFound);
				case "staleTransition":
					throw new AppError(Kind.ProposalNotCancellable, cancelDescription(result.actual));
				default:
					throw new AppError(Kind.Internal);
			}
		}

		config.onAuditEvent(result.auditEvent);

		if ("deferred" in result) {
			return c.json(
				{
					status: "pending",
					description: "Cancellation will take effect when the current settlement completes.",
				},
				202,
			);
		}

		return c.body(null, 204);
	});

	return app;
}

function cancelDescription(actualStatus: string | null): string {
	if (!actualStatus) return "Proposal cannot be cancelled from its current status.";
	return `Proposal cannot be cancelled because it has reached terminal status '${actualStatus}'.`;
}
