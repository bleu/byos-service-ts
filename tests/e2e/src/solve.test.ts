import type { Auction, SolveResponse } from "@byos/byos/src/infra/api/types.js";
import * as store from "@byos/byos/src/infra/storage.js";
import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signAndSubmitProposal, type TestApp } from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

function emptyAuction(overrides?: Partial<Auction>): Auction {
	return {
		id: "1",
		tokens: {},
		orders: [],
		effectiveGasPrice: "10000000000",
		deadline: "2099-01-01T00:00:00Z",
		...overrides,
	};
}

async function postSolve(auction: Auction): Promise<{ status: number; body: SolveResponse }> {
	const resp = await app.internalApp.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auction),
	});
	return { status: resp.status, body: await resp.json() };
}

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/** An auction holding one solvable sell order for `orderUid`. */
function solvableAuction(orderUid: string, overrides?: Partial<Auction>): Auction {
	return emptyAuction({
		tokens: {
			// 1 ETH per 1e18 atoms for both tokens
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
		...overrides,
	});
}

/** Submits a proposal with 1e18 surplus for `orderUid` and simulates it. */
async function seedSimulatedProposal(nonce: bigint, orderUid: `0x${string}`): Promise<number> {
	const { response } = await signAndSubmitProposal(app.publicApp, {
		orderUid,
		nonce,
		sellAmount: 10n ** 18n,
		buyAmount: 2n * 10n ** 18n,
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

describe("/solve", () => {
	it("empty auction returns empty solutions", async () => {
		const { status, body } = await postSolve(emptyAuction());
		expect(status).toBe(200);
		expect(body.solutions).toHaveLength(0);
	});

	it("publishes gas price from auction", async () => {
		await postSolve(emptyAuction({ effectiveGasPrice: "42000000000" }));
		expect(app.gasPriceRef.value).toBe(42_000_000_000n);
	});

	it("a gas price that does not fit u64 leaves the previous one in place", async () => {
		await postSolve(emptyAuction({ effectiveGasPrice: "42000000000" }));
		await postSolve(emptyAuction({ effectiveGasPrice: (2n ** 64n).toString() }));
		expect(app.gasPriceRef.value).toBe(42_000_000_000n);
	});

	it("returns solution for active proposal with gasUsed", async () => {
		// Proposal: sell 1e18, buy 2e18 (surplus = 1e18 buy tokens); order minimum: buy 1e18
		const orderUid = `0x${"ab".repeat(56)}` as const;
		await seedSimulatedProposal(500n, orderUid);

		const { status, body } = await postSolve(solvableAuction(orderUid));
		expect(status).toBe(200);
		expect(body.solutions.length).toBeGreaterThanOrEqual(1);

		const solution = body.solutions[0]!;
		expect(solution.trades).toHaveLength(1);
		expect(solution.interactions.length).toBeGreaterThanOrEqual(2); // transfer + execute
		expect(solution.gas).toBeGreaterThan(0);
	});

	it("malformed auction body returns 400", async () => {
		const { status } = await postSolve({ ...emptyAuction(), orders: "nope" } as never);
		expect(status).toBe(400);
	});

	it("invalid JSON returns 400", async () => {
		const resp = await app.internalApp.request("/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(resp.status).toBe(400);
	});

	it("a quote auction (no id) is answered without recording attribution", async () => {
		const orderUid = `0x${"cd".repeat(56)}` as const;
		const id = await seedSimulatedProposal(501n, orderUid);

		const { status, body } = await postSolve(solvableAuction(orderUid, { id: undefined }));
		expect(status).toBe(200);
		expect(body.solutions).toHaveLength(1);

		// Quote requests are never settled, so nothing was attributed —
		// in particular no row under the synthetic auction id 0.
		expect(await store.solutionProposals(app.ctx.db, 0, [1])).toHaveLength(0);
		expect(await store.solutionProposals(app.ctx.db, 0, [1, 2, 3])).not.toContainEqual(
			expect.objectContaining({ id }),
		);
	});

	it("a non-decimal auction id is rejected", async () => {
		const { status } = await postSolve(emptyAuction({ id: "12.5" }));
		expect(status).toBe(400);
	});

	it("internal healthz returns 200", async () => {
		const resp = await app.internalApp.request("/healthz");
		expect(resp.status).toBe(200);
	});
});
