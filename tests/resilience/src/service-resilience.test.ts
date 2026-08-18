import { auditEvents } from "@byos/byos/src/db/schema.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { byosDomain, computeInteractionsHash, signProposal, signReadAuth } from "@byos/common";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, describe, expect, it } from "vitest";
import {
	CHAIN_ID,
	type ServiceHandle,
	startService,
	TRAMPOLINE_FACTORY,
	waitForAuditDrain,
} from "./helpers.js";

// --- Signing fixtures (same as e2e helpers) ---

const SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SIGNER_ACCOUNT = privateKeyToAccount(SIGNER_KEY);
const DOMAIN = byosDomain(CHAIN_ID, TRAMPOLINE_FACTORY);

const signFn = (() => {
	const client = createWalletClient({
		account: SIGNER_ACCOUNT,
		chain: foundry,
		transport: http(),
	});
	// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
	return (params: any) => client.signTypedData(params);
})();

async function submitProposal(baseUrl: string, nonce: bigint) {
	const orderUid = `0x${"ab".repeat(56)}` as Hex;
	const sellAmount = 1_000_000n;
	const minBuyAmount = 990_000n;
	const quoteBuyAmount = 990_000n;
	const now = BigInt(Math.floor(Date.now() / 1000));
	const validUntil = now + 240n;
	const interactions = [
		{
			target: "0x00000000000000000000000000000000000000dd" as Address,
			value: 0n,
			callData: "0xdead" as Hex,
		},
	];
	const orderUidHash = keccak256(orderUid);
	const _interactionsHash = computeInteractionsHash(interactions);

	const proposal = {
		orderUidHash,
		sellAmount,
		minBuyAmount,
		quoteBuyAmount,
		validUntil,
		nonce,
	};
	const signature = await signProposal(signFn, DOMAIN, proposal, interactions);

	const resp = await fetch(`${baseUrl}/proposals`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			orderUid,
			sellAmount: sellAmount.toString(),
			minBuyAmount: minBuyAmount.toString(),
			quoteBuyAmount: quoteBuyAmount.toString(),
			interactions: interactions.map((i) => ({
				target: i.target,
				value: i.value.toString(),
				callData: i.callData,
			})),
			validUntil: validUntil.toString(),
			nonce: nonce.toString(),
			signature,
		}),
	});

	return resp;
}

// ---------------------------------------------------------------------------
// 1. Proposal survives service restart
// ---------------------------------------------------------------------------

describe("proposal survives restart", () => {
	let svc1: ServiceHandle;
	let svc2: ServiceHandle;
	let proposalId: number;

	afterAll(async () => {
		// svc1 is already shut down in the test
		await svc2?.shutdown();
		await svc2?.ctx.cleanup();
	});

	it("proposal created on instance 1 is readable on instance 2", async () => {
		// Boot instance 1
		svc1 = await startService();

		// Create a proposal
		const resp = await submitProposal(svc1.publicUrl, 1n);
		expect(resp.status).toBe(202);
		const body = await resp.json();
		proposalId = body.id;

		// Shut down instance 1
		await svc1.shutdown();

		// Boot instance 2 with the SAME database
		svc2 = await startService({ existingDb: svc1.ctx });

		// The proposal should be readable
		const sig = await signReadAuth(signFn, DOMAIN);
		const getResp = await fetch(`${svc2.publicUrl}/proposal/${proposalId}`, {
			headers: { "X-Signature": sig },
		});
		expect(getResp.status).toBe(200);
		const proposal = await getResp.json();
		expect(proposal.id).toBe(proposalId);
	});
});

// ---------------------------------------------------------------------------
// 2. Audit trail write-behind round-trip
// ---------------------------------------------------------------------------

describe("audit trail write-behind", () => {
	let svc: ServiceHandle;

	afterAll(async () => {
		await svc?.shutdown();
		await svc?.ctx.cleanup();
	});

	it("POST proposal creates a received audit event in Postgres", async () => {
		svc = await startService();

		const resp = await submitProposal(svc.publicUrl, 100n);
		expect(resp.status).toBe(202);
		const { id } = await resp.json();

		// Wait for BullMQ audit worker to drain
		await waitForAuditDrain(svc.redis);

		// Query audit_events table directly
		const events = await svc.ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.proposalId, id));

		expect(events.length).toBeGreaterThanOrEqual(1);
		const receivedEvent = events.find((e) => e.eventType === "received");
		expect(receivedEvent).toBeDefined();
		expect(receivedEvent!.proposalId).toBe(id);
	});
});

// ---------------------------------------------------------------------------
// 3. Validator verdict leaves audit evidence
// ---------------------------------------------------------------------------

describe("validator verdict audit evidence", () => {
	let svc: ServiceHandle;

	afterAll(async () => {
		await svc?.shutdown();
		await svc?.ctx.cleanup();
	});

	it("validation creates received + statusChanged audit events in Postgres", async () => {
		svc = await startService();

		// Submit a proposal (creates "received" audit event)
		const resp = await submitProposal(svc.publicUrl, 200n);
		expect(resp.status).toBe(202);
		const { id } = await resp.json();

		// Directly trigger validation via the proposal validation queue.
		// This exercises the real BullMQ → worker → DB pipeline without
		// depending on the scheduler's timing.
		const { Queue } = await import("bullmq");
		const validateQueue = new Queue("validate-proposal", {
			connection: svc.redis,
			prefix: "byos",
		});
		await validateQueue.add("validate-proposal", { proposalId: id }, { attempts: 1 });
		await validateQueue.close();

		// Wait for both audit events to land
		// Wait for both audit events to land in Postgres
		const deadline = Date.now() + 10_000;
		let found = false;
		while (Date.now() < deadline) {
			const events = await svc.ctx.db
				.select({ eventType: auditEvents.eventType, payload: auditEvents.payload })
				.from(auditEvents)
				.where(eq(auditEvents.proposalId, id));

			const received = events.find((e) => e.eventType === "received");
			// The audit event type is "validated" (from the validator verdict),
			// containing the status transition in its payload.
			const validated = events.find((e) => e.eventType === "validated");
			if (received && validated) {
				const payload = validated.payload as { from?: string; to?: string };
				expect(payload.from).toBe("submitted");
				expect(payload.to).toBe("active");
				found = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		expect(found, "both received and validated events should appear").toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. Audit IDs monotonic across restarts
// ---------------------------------------------------------------------------

describe("audit IDs monotonic across restarts", () => {
	let svc1: ServiceHandle;
	let svc2: ServiceHandle;

	afterAll(async () => {
		await svc2?.shutdown();
		await svc2?.ctx.cleanup();
	});

	it("audit event IDs are strictly increasing across service instances", async () => {
		// Instance 1: create 2 proposals
		svc1 = await startService();
		await submitProposal(svc1.publicUrl, 301n);
		await submitProposal(svc1.publicUrl, 302n);
		await waitForAuditDrain(svc1.redis);

		const eventsBeforeRestart = await svc1.ctx.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.orderBy(auditEvents.id);

		await svc1.shutdown();

		// Instance 2 (same DB): create 2 more proposals
		svc2 = await startService({ existingDb: svc1.ctx });
		await submitProposal(svc2.publicUrl, 303n);
		await submitProposal(svc2.publicUrl, 304n);
		await waitForAuditDrain(svc2.redis);

		const allEvents = await svc2.ctx.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.orderBy(auditEvents.id);

		// All IDs should be strictly increasing
		expect(allEvents.length).toBeGreaterThan(eventsBeforeRestart.length);
		for (let i = 1; i < allEvents.length; i++) {
			expect(allEvents[i].id).toBeGreaterThan(allEvents[i - 1].id);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Graceful shutdown drains audit queue
// ---------------------------------------------------------------------------

describe("graceful shutdown drains audit queue", () => {
	it("burst of proposals are all persisted before shutdown completes", async () => {
		const svc = await startService();

		// Submit 25 proposals in rapid succession
		const responses = await Promise.all(
			Array.from({ length: 25 }, (_, i) => submitProposal(svc.publicUrl, BigInt(500 + i))),
		);
		for (const resp of responses) {
			expect(resp.status).toBe(202);
		}

		// Shutdown should drain the audit queue
		await svc.shutdown();

		// Query the DB directly (service is down but DB connection is still open)
		const events = await svc.ctx.db
			.select({ id: auditEvents.id, eventType: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, "received"));

		// Each proposal creates a "received" audit event
		expect(events.length).toBe(25);

		await svc.ctx.cleanup();
	});
});

// ---------------------------------------------------------------------------
// 6. Retention sweep preserves audit trail
// ---------------------------------------------------------------------------

describe("retention sweep preserves audit trail", () => {
	let svc: ServiceHandle;

	afterAll(async () => {
		await svc?.shutdown();
		await svc?.ctx.cleanup();
	});

	it("swept proposal returns 404 but audit rows remain", async () => {
		// Fast retention sweep (1s interval), immediate sweep window (0s)
		svc = await startService({
			retentionSweepIntervalSecs: 1,
			droppedRetentionSecs: 0,
		});

		// Create a proposal and cancel it (cancelled is a sweepable status)
		const resp = await submitProposal(svc.publicUrl, 600n);
		expect(resp.status).toBe(202);
		const { id } = await resp.json();

		// Drive to cancelled via direct DB manipulation (faster than HTTP cancel
		// which would require signature for this specific proposal ID we don't know upfront)
		const proposal = (await store.get(svc.ctx.db, id))!;
		await store.transition(svc.ctx.db, proposal, "cancelled");

		// Wait for audit worker to drain the events from both create + cancel
		await waitForAuditDrain(svc.redis);

		// Count audit events before sweep
		const eventsBefore = await svc.ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.proposalId, id));
		expect(eventsBefore.length).toBeGreaterThanOrEqual(1);

		// Wait for retention sweep to run (1s interval + processing time)
		const deadline = Date.now() + 10_000;
		let swept = false;
		while (Date.now() < deadline) {
			const p = await store.get(svc.ctx.db, id);
			if (p === null) {
				swept = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		expect(swept, "cancelled proposal should be swept within 10s").toBe(true);

		// Audit trail should still be present
		const eventsAfter = await svc.ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.proposalId, id));
		expect(eventsAfter.length).toBe(eventsBefore.length);
	});
});

// ---------------------------------------------------------------------------
// 7. Proposal IDs are monotonically increasing across restarts
// ---------------------------------------------------------------------------

describe("proposal IDs increase across restarts", () => {
	let svc1: ServiceHandle;
	let svc2: ServiceHandle;

	afterAll(async () => {
		await svc2?.shutdown();
		await svc2?.ctx.cleanup();
	});

	it("proposal IDs from instance 2 are higher than instance 1", async () => {
		svc1 = await startService();

		const resp1 = await submitProposal(svc1.publicUrl, 700n);
		const { id: id1 } = await resp1.json();
		const resp2 = await submitProposal(svc1.publicUrl, 701n);
		const { id: id2 } = await resp2.json();

		await svc1.shutdown();

		svc2 = await startService({ existingDb: svc1.ctx });

		const resp3 = await submitProposal(svc2.publicUrl, 702n);
		const { id: id3 } = await resp3.json();

		expect(id2).toBeGreaterThan(id1);
		expect(id3).toBeGreaterThan(id2);
	});
});

// ---------------------------------------------------------------------------
// 8. Healthz is available on both listeners
// ---------------------------------------------------------------------------

describe("service health check", () => {
	let svc: ServiceHandle;

	afterAll(async () => {
		await svc?.shutdown();
		await svc?.ctx.cleanup();
	});

	it("healthz returns 200 on public and internal listeners", async () => {
		svc = await startService();

		const publicResp = await fetch(`${svc.publicUrl}/healthz`);
		expect(publicResp.status).toBe(200);

		const internalResp = await fetch(`${svc.internalUrl}/healthz`);
		expect(internalResp.status).toBe(200);
	});
});
