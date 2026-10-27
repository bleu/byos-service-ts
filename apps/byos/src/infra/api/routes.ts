import {
	byosDomain,
	createProposalRequestSchema,
	type Eip1271Verifier,
	hashProposalData,
	recoverCanceller,
	recoverProposer,
	recoverReader,
} from "@byos/common";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Address } from "viem";
// @ts-expect-error — tsup loader: { '.yml': 'text' } inlines this as a string at build time
import _openapiYaml from "../../../openapi.yml";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { ValidateProposal, Verdict } from "../../domain/validator.js";
import { getAuctionState } from "../auction-state.js";
import type { Candidate } from "../candidate-store.js";
import { CandidateStore } from "../candidate-store.js";
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
	cL: bigint;
	onAuditEvent: (event: AuditEvent) => void;
	validator: ValidateProposal;
	candidateStore: CandidateStore;
	signerLimit: SignerLimitConfig;
	/** If set, only sub-solvers in this set (lowercase) are admitted. */
	subsolverWhitelist?: Set<string> | null;
	/** EIP-1271 verifier. Required for contract sub-solvers. See ADR-0020. */
	verifyEip1271?: Eip1271Verifier;
	logger?: Logger;
}

export function createPublicRoutes(config: RoutesConfig) {
	const app = new Hono();
	const domain = byosDomain(config.chainId, config.trampolineFactory);
	const log = config.logger?.child({ component: "ingestion" });

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	app.get("/openapi.yaml", (c) =>
		c.text(_openapiYaml, 200, { "Content-Type": "application/yaml" }),
	);

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

		// The schema pins the hex grammar. For EOA signers (no subSolverAddress)
		// the signature must be exactly 65 bytes, as in Rust's Signature::try_from.
		// For contract signers the EIP-1271 contract decides validity, so we only
		// enforce a generous upper bound (4096 bytes) to prevent abuse.
		const signatureDigits = body.signature.startsWith("0x")
			? body.signature.length - 2
			: body.signature.length;
		if (body.subSolverAddress === undefined) {
			if (signatureDigits !== 130) {
				throw new AppError(Kind.InvalidSignature);
			}
		} else {
			if (signatureDigits === 0 || signatureDigits > 8192) {
				throw new AppError(Kind.InvalidSignature);
			}
		}

		let parsed: ReturnType<typeof parseCreateProposalRequest>;
		try {
			parsed = parseCreateProposalRequest(body);
		} catch {
			throw new AppError(Kind.BadRequest, "Failed to parse proposal fields");
		}

		// Resolve sub-solver address. For EOA signers, recover it from the ECDSA
		// signature. For contract signers (`subSolverAddress` present), try ECDSA
		// first (covers EOAs that declare their address); if that misses, fall back
		// to an EIP-1271 on-chain call. See ADR-0020.
		let subSolver: Address;
		if (parsed.subSolverAddress === undefined) {
			// Existing EOA path — no change.
			try {
				subSolver = await recoverProposer(
					parsed.signature,
					domain,
					{
						orderUidHash: parsed.orderUidHash,
						sellToken: parsed.sellToken,
						buyToken: parsed.buyToken,
						sellAmount: parsed.sellAmount,
						minBuyAmount: parsed.minBuyAmount,
						quoteBuyAmount: parsed.quoteBuyAmount,
						validUntil: parsed.validUntil,
						nonce: parsed.nonce,
					},
					parsed.interactionsHash,
				);
			} catch {
				throw new AppError(Kind.SignatureRecoveryFailed);
			}
		} else {
			// Contract signer path. Try ECDSA first — no RPC, covers EOAs that
			// opt in to declaring their address.
			const proposalData = {
				orderUidHash: parsed.orderUidHash,
				sellToken: parsed.sellToken,
				buyToken: parsed.buyToken,
				sellAmount: parsed.sellAmount,
				minBuyAmount: parsed.minBuyAmount,
				quoteBuyAmount: parsed.quoteBuyAmount,
				validUntil: parsed.validUntil,
				nonce: parsed.nonce,
			};
			let ecdsaMatched = false;
			try {
				const recovered = await recoverProposer(
					parsed.signature,
					domain,
					proposalData,
					parsed.interactionsHash,
				);
				ecdsaMatched = recovered.toLowerCase() === parsed.subSolverAddress.toLowerCase();
			} catch {
				// Signature is not a valid 65-byte ECDSA sig; fall through to EIP-1271.
			}

			if (ecdsaMatched) {
				subSolver = parsed.subSolverAddress;
			} else {
				// ECDSA didn't match — try EIP-1271 on-chain call.
				if (!config.verifyEip1271) {
					throw new AppError(Kind.Eip1271NotAvailable);
				}
				const digest = hashProposalData(domain, proposalData, parsed.interactionsHash);
				const valid = await config
					.verifyEip1271(parsed.subSolverAddress, digest, parsed.signature)
					.catch(() => false);
				if (!valid) {
					throw new AppError(Kind.SignatureRecoveryFailed);
				}
				subSolver = parsed.subSolverAddress;
			}
		}

		if (config.subsolverWhitelist && !config.subsolverWhitelist.has(subSolver.toLowerCase())) {
			throw new AppError(Kind.SubsolverNotAllowed);
		}

		// The floor gate is a write-side control: a sub-solver whose withdrawal
		// is pending must still be able to read and cancel what it has live.
		try {
			await enforceSignerLimit(config.signerLimit, subSolver, { enforceEscrowFloor: true });
		} catch (err) {
			log?.warn({ reason: (err as { kind?: string }).kind }, "proposal rejected at ingestion");
			throw err;
		}

		// Validate expiry
		const now = BigInt(Math.floor(Date.now() / 1000));
		if (parsed.validUntil <= now) {
			throw new AppError(Kind.ProposalExpired);
		}
		if (parsed.validUntil > now + BigInt(config.maxProposalLifetimeSecs)) {
			throw new AppError(Kind.ProposalLifetimeExceeded);
		}

		// Proposals are per-auction. Reject if no auction is active or if the
		// order is not in the current auction.
		const auctionState = await getAuctionState();
		if (!auctionState) {
			throw new AppError(Kind.NoActiveAuction);
		}
		if (!auctionState.orders.has(parsed.orderUid.toLowerCase())) {
			throw new AppError(Kind.UnknownOrder);
		}
		const { auctionId } = auctionState;

		// Allocate an ID from the proposals sequence without inserting a row.
		// This ID is used in the proposals_log (on reject) or proposals table (on /solve selection).
		const id = await CandidateStore.allocateId(config.db);

		// Build a proposal-like object for the validator.
		// status is set to "submitted" so the profitability gate runs.
		const proposalForValidation = {
			id,
			subSolver,
			orderUid: parsed.orderUid,
			orderUidHash: parsed.orderUidHash,
			sellToken: parsed.sellToken,
			buyToken: parsed.buyToken,
			sellAmount: parsed.sellAmount,
			minBuyAmount: parsed.minBuyAmount,
			quoteBuyAmount: parsed.quoteBuyAmount,
			interactions: parsed.interactions,
			interactionsHash: parsed.interactionsHash,
			validUntil: parsed.validUntil,
			nonce: parsed.nonce,
			signature: parsed.signature,
			status: "submitted" as const,
			rejectionReason: null,
			gasUsed: null,
			trampoline: null,
			settlementTxHash: null,
			penaltyTxHash: null,
			sellTokenRefPrice: null,
			buyTokenRefPrice: null,
			surplusTokenRefPrice: null,
			auctionGasPrice: null,
			clearingPrices: null,
			simulationBuyAmount: null,
			simulationFailureParams: null,
			settlementPenaltyCap: null,
			auctionId,
			createdAt: new Date(),
			statusChangedAt: new Date(),
		};

		log?.info(
			{
				id,
				subSolver,
				orderUid: parsed.orderUid,
				sellToken: parsed.sellToken,
				buyToken: parsed.buyToken,
			},
			"proposal received — validating inline",
		);

		// Run validation inline. A null verdict means auction state is unavailable — defer.
		let verdict: Verdict | null;
		try {
			verdict = await config.validator.validate(proposalForValidation);
		} catch {
			verdict = null;
		}
		if (!verdict) {
			// Auction state unavailable — write to log as rejected (AuctionClosed)
			// so the sub-solver gets clear feedback. Don't silently discard.
			await store.writeToLog(
				config.db,
				id,
				{ ...proposalForValidation, settlementPenaltyCap: null },
				"rejected",
				"AuctionClosed",
				null,
			);
			throw new AppError(Kind.NoActiveAuction);
		}

		if (verdict.kind === "reject") {
			const reason = verdict.reason;
			log?.info({ id, subSolver, reason }, "proposal rejected at validation");
			await store.writeToLog(
				config.db,
				id,
				{ ...proposalForValidation, settlementPenaltyCap: null },
				"rejected",
				reason,
				null,
			);
			config.onAuditEvent({
				occurredAt: new Date(),
				kind: {
					type: "statusChanged",
					proposalId: id,
					subSolver,
					orderUid: parsed.orderUid,
					from: "submitted",
					to: "rejected",
					rejectionReason: reason,
					settlementTxHash: null,
				},
			});
			throw new AppError(Kind.ProposalRejected, reason);
		}

		if (verdict.kind === "simFailed") {
			// "GPv2: order filled" means an external solver won the CoW auction.
			// Promote to rejected: SolverOutbid so sub-solvers get a clear signal.
			const isFilled = verdict.revertReason === "GPv2: order filled";
			const toStatus = isFilled ? ("rejected" as const) : ("simFailed" as const);
			const rejectionReason = isFilled ? ("SolverOutbid" as const) : null;
			log?.info({ id, subSolver, revertReason: verdict.revertReason }, "proposal sim failed");
			await store.writeToLog(
				config.db,
				id,
				{ ...proposalForValidation, settlementPenaltyCap: null },
				toStatus,
				rejectionReason,
				verdict.simulationFailureParams ?? null,
			);
			config.onAuditEvent({
				occurredAt: new Date(),
				kind: {
					type: "statusChanged",
					proposalId: id,
					subSolver,
					orderUid: parsed.orderUid,
					from: "submitted",
					to: toStatus,
					rejectionReason,
					settlementTxHash: null,
				},
			});
			throw new AppError(Kind.ProposalRejected, isFilled ? "SolverOutbid" : "SimFailed");
		}

		// verdict.kind === "accept" — hold as candidate in memory
		const sim = verdict.simulation;
		if (!sim) {
			// Shouldn't happen: accept always has simulation data
			throw new AppError(Kind.Internal);
		}

		const candidate: Candidate = {
			id,
			subSolver,
			orderUid: parsed.orderUid,
			orderUidHash: parsed.orderUidHash,
			sellAmount: parsed.sellAmount,
			minBuyAmount: parsed.minBuyAmount,
			quoteBuyAmount: parsed.quoteBuyAmount,
			sellToken: sim.sellToken,
			buyToken: sim.buyToken,
			interactions: parsed.interactions,
			interactionsHash: parsed.interactionsHash,
			validUntil: parsed.validUntil,
			nonce: parsed.nonce,
			signature: parsed.signature,
			auctionId,
			gasUsed: sim.gasUsed,
			trampoline: sim.trampoline,
			simulationBuyAmount: sim.simulationBuyAmount,
			sellTokenRefPrice: sim.sellTokenRefPrice.toString(),
			createdAt: new Date(),
		};

		config.candidateStore.add(candidate);

		config.onAuditEvent({
			occurredAt: new Date(),
			kind: {
				type: "received",
				proposal: {
					...proposalForValidation,
					sellToken: sim.sellToken,
					buyToken: sim.buyToken,
					gasUsed: sim.gasUsed,
					trampoline: sim.trampoline,
					simulationBuyAmount: sim.simulationBuyAmount,
					sellTokenRefPrice: sim.sellTokenRefPrice.toString(),
				},
			},
		});

		log?.info({ id, subSolver, orderUid: parsed.orderUid }, "proposal accepted as candidate");
		return c.json({ id }, 200);
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

		// Check candidate store first (in-memory proposals not yet in DB).
		const candidate = config.candidateStore.getForOwner(id, reader);
		if (candidate) {
			return c.json(
				proposalToGetResponse({
					id: candidate.id,
					subSolver: candidate.subSolver,
					orderUid: candidate.orderUid,
					orderUidHash: candidate.orderUidHash,
					sellAmount: candidate.sellAmount,
					minBuyAmount: candidate.minBuyAmount,
					quoteBuyAmount: candidate.quoteBuyAmount,
					sellToken: candidate.sellToken,
					buyToken: candidate.buyToken,
					interactions: candidate.interactions,
					interactionsHash: candidate.interactionsHash,
					validUntil: candidate.validUntil,
					nonce: candidate.nonce,
					signature: candidate.signature,
					status: "candidate",
					rejectionReason: null,
					gasUsed: candidate.gasUsed,
					trampoline: candidate.trampoline,
					settlementTxHash: null,
					penaltyTxHash: null,
					sellTokenRefPrice: candidate.sellTokenRefPrice,
					buyTokenRefPrice: null,
					surplusTokenRefPrice: null,
					auctionGasPrice: null,
					clearingPrices: null,
					simulationBuyAmount: candidate.simulationBuyAmount,
					simulationFailureParams: null,
					settlementPenaltyCap: null,
					auctionId: candidate.auctionId,
					createdAt: candidate.createdAt,
					statusChangedAt: candidate.createdAt,
				}),
			);
		}

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

		const includeArchived = c.req.query("includeArchived") === "true";
		const dbProposals = await store.listBySubSolver(config.db, reader, includeArchived);

		// Also include in-memory candidates for this sub-solver
		// (only when not querying archived, as candidates are not archived).
		const candidateProposals = includeArchived
			? []
			: config.candidateStore
					.getAll()
					.filter((c) => c.subSolver.toLowerCase() === reader.toLowerCase())
					.map((candidate) => ({
						id: candidate.id,
						subSolver: candidate.subSolver,
						orderUid: candidate.orderUid,
						orderUidHash: candidate.orderUidHash,
						sellAmount: candidate.sellAmount,
						minBuyAmount: candidate.minBuyAmount,
						quoteBuyAmount: candidate.quoteBuyAmount,
						sellToken: candidate.sellToken,
						buyToken: candidate.buyToken,
						interactions: candidate.interactions,
						interactionsHash: candidate.interactionsHash,
						validUntil: candidate.validUntil,
						nonce: candidate.nonce,
						signature: candidate.signature,
						status: "candidate" as const,
						rejectionReason: null,
						gasUsed: candidate.gasUsed,
						trampoline: candidate.trampoline,
						settlementTxHash: null,
						penaltyTxHash: null,
						sellTokenRefPrice: candidate.sellTokenRefPrice,
						buyTokenRefPrice: null,
						surplusTokenRefPrice: null,
						auctionGasPrice: null,
						clearingPrices: null,
						simulationBuyAmount: candidate.simulationBuyAmount,
						simulationFailureParams: null,
						settlementPenaltyCap: null,
						auctionId: candidate.auctionId,
						createdAt: candidate.createdAt,
						statusChangedAt: candidate.createdAt,
					}));

		return c.json(proposalToListResponse([...candidateProposals, ...dbProposals]));
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

		const includeArchived = c.req.query("includeArchived") === "true";
		const proposals = await store.listByOrderUidForOwner(
			config.db,
			orderUid,
			reader,
			includeArchived,
		);
		return c.json(proposalToListResponse(proposals));
	});

	// GET /buffer-balance — Off-chain buffer accounting (owner-scoped)
	app.get("/buffer-balance", async (c) => {
		const sig = extractSignature(c);
		let reader: Address;
		try {
			reader = await recoverReader(sig, domain);
		} catch {
			throw new AppError(Kind.SignatureRecoveryFailed);
		}

		await enforceSignerLimit(config.signerLimit, reader);

		const entries = await store.unclearedBufferEntries(config.db, reader);
		let outstandingBalance = 0n;
		for (const entry of entries) {
			outstandingBalance += BigInt(entry.nativeTokenAmount);
		}

		return c.json({
			outstandingBalance: outstandingBalance.toString(),
			threshold: config.cL.toString(),
			entries: entries.map((e) => ({
				proposalId: e.proposalId,
				orderUid: e.orderUid,
				buyToken: e.buyToken,
				delta: e.delta,
				gap: e.gap,
				nativeTokenAmount: e.nativeTokenAmount,
				createdAt: e.createdAt.toISOString(),
			})),
		});
	});

	// DELETE /proposal/:id — Cancel proposal (candidates only)
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

		// Cancel from candidate store (in-memory).
		const candidate = config.candidateStore.getForOwner(id, canceller);
		if (candidate) {
			config.candidateStore.remove(id);
			// Write to log so sub-solvers can see the cancellation.
			await store.writeToLog(
				config.db,
				id,
				{
					subSolver: candidate.subSolver,
					orderUid: candidate.orderUid,
					orderUidHash: candidate.orderUidHash,
					sellToken: candidate.sellToken,
					buyToken: candidate.buyToken,
					sellAmount: candidate.sellAmount,
					minBuyAmount: candidate.minBuyAmount,
					quoteBuyAmount: candidate.quoteBuyAmount,
					interactions: candidate.interactions,
					interactionsHash: candidate.interactionsHash,
					validUntil: candidate.validUntil,
					nonce: candidate.nonce,
					signature: candidate.signature,
					status: "cancelled",
					rejectionReason: null,
					gasUsed: candidate.gasUsed,
					trampoline: candidate.trampoline,
					settlementTxHash: null,
					penaltyTxHash: null,
					sellTokenRefPrice: candidate.sellTokenRefPrice,
					buyTokenRefPrice: null,
					surplusTokenRefPrice: null,
					auctionGasPrice: null,
					clearingPrices: null,
					simulationBuyAmount: candidate.simulationBuyAmount,
					settlementPenaltyCap: null,
					auctionId: candidate.auctionId,
				},
				"cancelled",
				null,
				null,
			);
			config.onAuditEvent({
				occurredAt: new Date(),
				kind: {
					type: "cancelled",
					proposalId: id,
					subSolver: canceller,
					orderUid: candidate.orderUid,
				},
			});
			return c.body(null, 204);
		}

		// Check if the proposal is in proposals (submitted — not cancellable).
		const submitted = await store.get(config.db, id);
		if (submitted) {
			if (submitted.subSolver.toLowerCase() !== canceller.toLowerCase()) {
				// Don't leak existence info — treat as not found (ADR-0011)
				throw new AppError(Kind.ProposalNotFound);
			}
			throw new AppError(
				Kind.ProposalNotCancellable,
				"Proposal is already submitted to the driver and cannot be cancelled.",
			);
		}

		throw new AppError(Kind.ProposalNotFound);
	});

	return app;
}

