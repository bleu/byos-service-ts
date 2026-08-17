import * as store from "@byos/byos/src/infra/storage.js";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestApp,
	otherReadAuthHeader,
	readAuthHeader,
	SIGNER_ACCOUNT,
	seedProposal,
	type TestApp,
} from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

async function getSlippageBalance(sigFn: () => Promise<Hex> = readAuthHeader) {
	const sig = await sigFn();
	const resp = await app.publicApp.request("/slippage-balance", {
		headers: { "X-Signature": sig },
	});
	return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe("GET /slippage-balance", () => {
	it("returns empty balance with no slippage entries", async () => {
		const { status, body } = await getSlippageBalance();
		expect(status).toBe(200);
		expect(body.outstandingBalance).toBe("0");
		expect(body.threshold).toBeDefined();
		expect(body.entries).toEqual([]);
	});

	it("returns uncleared entries for the authenticated subsolver", async () => {
		// Seed a settled proposal with slippage and insert a ledger entry
		const orderUid = `0x${"e1".repeat(56)}`;
		const id = await seedProposal(app.ctx.db, {
			orderUid,
			subSolver: SIGNER_ACCOUNT.address,
			status: "settled",
			minBuyAmount: 900n,
			quoteBuyAmount: 1000n,
			settlementTxHash: `0x${"a1".repeat(32)}`,
		});

		await store.insertSlippageEntry(app.ctx.db, {
			subSolver: SIGNER_ACCOUNT.address as Address,
			proposalId: id,
			orderUid,
			buyToken: "0x0000000000000000000000000000000000000000" as Address,
			delta: "950",
			gap: "50",
			nativeTokenAmount: "50000000000000000",
		});

		const { status, body } = await getSlippageBalance();
		expect(status).toBe(200);
		expect(BigInt(body.outstandingBalance as string)).toBe(50_000_000_000_000_000n);

		const entries = body.entries as Array<Record<string, unknown>>;
		const entry = entries.find((e) => e.proposalId === id);
		expect(entry).toBeDefined();
		expect(entry?.delta).toBe("950");
		expect(entry?.gap).toBe("50");
		expect(entry?.nativeTokenAmount).toBe("50000000000000000");
		expect(entry?.createdAt).toBeDefined();
	});

	it("does not leak entries from other subsolvers", async () => {
		const orderUid = `0x${"e2".repeat(56)}`;
		const otherSolver = "0x0202020202020202020202020202020202020202" as Address;
		const id = await seedProposal(app.ctx.db, {
			orderUid,
			subSolver: otherSolver,
			status: "settled",
			minBuyAmount: 900n,
			quoteBuyAmount: 1000n,
			settlementTxHash: `0x${"a2".repeat(32)}`,
		});

		await store.insertSlippageEntry(app.ctx.db, {
			subSolver: otherSolver,
			proposalId: id,
			orderUid,
			buyToken: "0x0000000000000000000000000000000000000000" as Address,
			delta: "950",
			gap: "50",
			nativeTokenAmount: "50000000000000000",
		});

		// Query as the other solver — should see the entry
		const { body: otherBody } = await getSlippageBalance(otherReadAuthHeader);
		const otherEntries = otherBody.entries as Array<Record<string, unknown>>;
		// The other signer is a different account, won't see entries for otherSolver
		const leaked = otherEntries.find((e) => e.proposalId === id);
		expect(leaked).toBeUndefined();
	});

	it("excludes cleared entries from the response", async () => {
		const orderUid = `0x${"e3".repeat(56)}`;
		const id = await seedProposal(app.ctx.db, {
			orderUid,
			subSolver: SIGNER_ACCOUNT.address,
			status: "settled",
			minBuyAmount: 900n,
			quoteBuyAmount: 1000n,
			settlementTxHash: `0x${"a3".repeat(32)}`,
		});

		await store.insertSlippageEntry(app.ctx.db, {
			subSolver: SIGNER_ACCOUNT.address as Address,
			proposalId: id,
			orderUid,
			buyToken: "0x0000000000000000000000000000000000000000" as Address,
			delta: "950",
			gap: "50",
			nativeTokenAmount: "50000000000000000",
		});

		// Clear the entry
		const clearTx = `0x${"b3".repeat(32)}` as Hex;
		await store.clearSlippageEntries(app.ctx.db, SIGNER_ACCOUNT.address as Address, clearTx);

		const { body } = await getSlippageBalance();
		const entries = body.entries as Array<Record<string, unknown>>;
		const cleared = entries.find((e) => e.proposalId === id);
		expect(cleared).toBeUndefined();
	});

	it("rejects requests without a signature", async () => {
		const resp = await app.publicApp.request("/slippage-balance");
		expect(resp.status).toBe(400);
	});
});
