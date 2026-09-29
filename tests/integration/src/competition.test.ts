/**
 * Integration tests for competition-aware status transitions.
 *
 * (i) SubsolverOutbid: when /solve selects one sub-solver's proposal,
 *     all other active proposals for the same orderUid are immediately
 *     marked rejected: SubsolverOutbid.
 *
 * (ii) SolverOutbid: when estimateGas reverts with "GPv2: order filled",
 *      the proposal is marked rejected: SolverOutbid instead of simFailed.
 */

import type { Auction } from "@byos/byos/src/infra/api/types.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { RejectionReason, signProposal } from "@byos/common";
import type { Address } from "viem";
import { type Hex, keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestApp,
	DOMAIN,
	OTHER_SIGN_FN,
	signAndSubmitProposal,
	type TestApp,
} from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function solvableAuction(orderUid: string, overrides?: Partial<Auction>): Auction {
	return {
		id: "1",
		tokens: {
			[SELL_TOKEN]: {
				referencePrice: "1000000000000000000",
				availableBalance: "0",
				trusted: false,
			},
			[BUY_TOKEN]: { referencePrice: "1000000000000000000", availableBalance: "0", trusted: false },
		},
		orders: [
			{
				uid: orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: (10n ** 18n).toString(),
				fullSellAmount: (10n ** 18n).toString(),
				buyAmount: (10n ** 18n).toString(),
				fullBuyAmount: (10n ** 18n).toString(),
				validTo: 4294967295,
				kind: "sell",
				owner: "0x0000000000000000000000000000000000000000",
				partiallyFillable: false,
				preInteractions: [],
				postInteractions: [],
				sellTokenSource: "erc20",
				buyTokenDestination: "erc20",
				class: "limit",
				appData: `0x${"00".repeat(32)}`,
				signingScheme: "eip712",
				signature: "0x",
			},
		],
		effectiveGasPrice: "10000000000",
		deadline: "2099-01-01T00:00:00Z",
		...overrides,
	};
}

/** Submits a proposal from the default signer with simulated gasUsed. */
async function seedSimulatedProposal(nonce: bigint, orderUid: `0x${string}`): Promise<number> {
	const { response } = await signAndSubmitProposal(app.publicApp, {
		orderUid,
		nonce,
		sellAmount: 10n ** 18n,
		minBuyAmount: 2n * 10n ** 18n,
		quoteBuyAmount: 2n * 10n ** 18n,
	});
	const { id } = await response.json();

	await store.resolveVerdict(app.ctx.db, id, {
		kind: "accept",
		simulation: {
			gasUsed: 150_000n,
			trampoline: "0x0000000000000000000000000000000000001234" as Address,
			sellToken: SELL_TOKEN as Address,
			buyToken: BUY_TOKEN as Address,
		},
	});

	return id;
}

/**
 * Submits a proposal from the OTHER signer (second sub-solver),
 * with slightly better pricing so it scores higher.
 */
async function seedSimulatedProposalOther(nonce: bigint, orderUid: `0x${string}`): Promise<number> {
	const sellToken = SELL_TOKEN as Address;
	const buyToken = BUY_TOKEN as Address;
	const sellAmount = 10n ** 18n;
	const minBuyAmount = 2n * 10n ** 18n;
	// Higher quoteBuyAmount = better score = wins the competition
	const quoteBuyAmount = 3n * 10n ** 18n;
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
	const proposal = {
		orderUidHash,
		sellToken,
		buyToken,
		sellAmount,
		minBuyAmount,
		quoteBuyAmount,
		validUntil,
		nonce,
	};
	const signature = await signProposal(OTHER_SIGN_FN, DOMAIN, proposal, interactions);

	const body = {
		orderUid,
		sellToken,
		buyToken,
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
	};

	const response = await app.publicApp.request("/proposals", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const { id } = await response.json();

	await store.resolveVerdict(app.ctx.db, id, {
		kind: "accept",
		simulation: {
			gasUsed: 150_000n,
			trampoline: "0x0000000000000000000000000000000000001234" as Address,
			sellToken: SELL_TOKEN as Address,
			buyToken: BUY_TOKEN as Address,
		},
	});

	return id;
}

async function getProposal(id: number, useOtherSigner = false) {
	const { readAuthHeader, otherReadAuthHeader } = await import("./helpers.js");
	const auth = useOtherSigner ? await otherReadAuthHeader() : await readAuthHeader();
	const resp = await app.publicApp.request(`/proposal/${id}`, {
		headers: { "x-signature": auth },
	});
	return resp.json();
}

async function postSolve(auction: Auction) {
	const resp = await app.internalApp.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auction),
	});
	return { status: resp.status, body: await resp.json() };
}

// ── SubsolverOutbid ───────────────────────────────────────────────────────────

describe("SubsolverOutbid", () => {
	it("marks losing sub-solver proposals as rejected: SubsolverOutbid after /solve", async () => {
		const orderUid = `0x${"e1".repeat(56)}` as const;

		// Two sub-solvers compete for the same order
		const losingId = await seedSimulatedProposal(1000n, orderUid);
		const winningId = await seedSimulatedProposalOther(1001n, orderUid);

		const { status } = await postSolve(solvableAuction(orderUid));
		expect(status).toBe(200);

		// Winning proposal keeps its active status (still executing)
		const winner = await getProposal(winningId, true);
		expect(winner.status).not.toBe("rejected");

		// Losing proposal is immediately marked SubsolverOutbid
		const loser = await getProposal(losingId);
		expect(loser.status).toBe("rejected");
		expect(loser.rejectionReason).toBe(RejectionReason.SubsolverOutbid);
	});

	it("does not reject proposals when the auction has no id (quote auction)", async () => {
		const orderUid = `0x${"e2".repeat(56)}` as const;

		const id1 = await seedSimulatedProposal(1002n, orderUid);
		const id2 = await seedSimulatedProposalOther(1003n, orderUid);

		// Quote auction — no id
		await postSolve(solvableAuction(orderUid, { id: undefined }));

		// Neither proposal should be outbid-rejected in a quote auction
		const p1 = await getProposal(id1);
		const p2 = await getProposal(id2, true);
		expect(p1.rejectionReason).not.toBe(RejectionReason.SubsolverOutbid);
		expect(p2.rejectionReason).not.toBe(RejectionReason.SubsolverOutbid);
	});

	it("only marks proposals for the winning order, not other orders", async () => {
		const orderUid1 = `0x${"e3".repeat(56)}` as const;
		const orderUid2 = `0x${"e4".repeat(56)}` as const;

		// One proposal for each distinct order
		const id1 = await seedSimulatedProposal(1004n, orderUid1);
		const id2 = await seedSimulatedProposal(1005n, orderUid2);

		// Auction that only includes orderUid1
		await postSolve(solvableAuction(orderUid1));

		// Proposal for orderUid2 must not be touched
		const p2 = await getProposal(id2);
		expect(p2.rejectionReason).not.toBe(RejectionReason.SubsolverOutbid);
		// Clean up: id1 may be active still, that's fine
		void id1;
	});
});

// ── SolverOutbid ──────────────────────────────────────────────────────────────

describe("SolverOutbid", () => {
	it("resolveVerdict with simFailed + revertReason 'GPv2: order filled' → rejected: SolverOutbid", async () => {
		const orderUid = `0x${"f1".repeat(56)}` as const;
		const { response } = await signAndSubmitProposal(app.publicApp, {
			orderUid,
			nonce: 2000n,
		});
		const { id } = await response.json();

		// Simulate validator returning simFailed with "GPv2: order filled"
		await store.resolveVerdict(app.ctx.db, id, {
			kind: "simFailed",
			revertReason: "GPv2: order filled",
		});

		const proposal = await getProposal(id);
		expect(proposal.status).toBe("rejected");
		expect(proposal.rejectionReason).toBe(RejectionReason.SolverOutbid);
	});

	it("resolveVerdict with simFailed + other revert reason → stays simFailed", async () => {
		const orderUid = `0x${"f2".repeat(56)}` as const;
		const { response } = await signAndSubmitProposal(app.publicApp, {
			orderUid,
			nonce: 2001n,
		});
		const { id } = await response.json();

		await store.resolveVerdict(app.ctx.db, id, {
			kind: "simFailed",
			revertReason: "ERC20: insufficient allowance",
		});

		const proposal = await getProposal(id);
		expect(proposal.status).toBe("simFailed");
		expect(proposal.rejectionReason).not.toBe(RejectionReason.SolverOutbid);
	});

	it("resolveVerdict with simFailed and no revert reason → stays simFailed", async () => {
		const orderUid = `0x${"f3".repeat(56)}` as const;
		const { response } = await signAndSubmitProposal(app.publicApp, {
			orderUid,
			nonce: 2002n,
		});
		const { id } = await response.json();

		await store.resolveVerdict(app.ctx.db, id, { kind: "simFailed" });

		const proposal = await getProposal(id);
		expect(proposal.status).toBe("simFailed");
	});
});
