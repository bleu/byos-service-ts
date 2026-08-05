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

	it("returns solution for active proposal with gasUsed", async () => {
		// Submit a proposal with significant surplus (buy much more than order minimum)
		// Proposal: sell 1e18, buy 2e18 (surplus = 2e18 - 1e18 = 1e18 buy tokens)
		// Order minimum: buy 1e18
		const { response } = await signAndSubmitProposal(app.publicApp, {
			nonce: 500n,
			sellAmount: 10n ** 18n,
			buyAmount: 2n * 10n ** 18n,
		});
		const { id } = await response.json();

		// Directly update proposal to active with gasUsed and trampoline
		await store.resolveVerdict(app.ctx.db, id, {
			kind: "accept",
			simulation: {
				gasUsed: 150_000n,
				trampoline: "0x0000000000000000000000000000000000001234" as Address,
				sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
				buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
			},
		});

		const orderUid = `0x${"ab".repeat(56)}`;
		const sellToken = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
		const buyToken = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

		const auction = emptyAuction({
			tokens: {
				// 1 ETH per 1e18 atoms for both tokens
				[sellToken]: {
					referencePrice: "1000000000000000000",
					availableBalance: "0",
					trusted: false,
				},
				[buyToken]: {
					referencePrice: "1000000000000000000",
					availableBalance: "0",
					trusted: false,
				},
			},
			orders: [
				{
					uid: orderUid,
					sellToken,
					buyToken,
					sellAmount: (10n ** 18n).toString(),
					fullSellAmount: (10n ** 18n).toString(),
					buyAmount: (10n ** 18n).toString(), // order minimum much below proposal's 2e18
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
		});

		const { status, body } = await postSolve(auction);
		expect(status).toBe(200);
		expect(body.solutions.length).toBeGreaterThanOrEqual(1);

		const solution = body.solutions[0]!;
		expect(solution.trades).toHaveLength(1);
		expect(solution.interactions.length).toBeGreaterThanOrEqual(2); // transfer + execute
		expect(solution.gas).toBeGreaterThan(0);
	});

	it("internal healthz returns 200", async () => {
		const resp = await app.internalApp.request("/healthz");
		expect(resp.status).toBe(200);
	});
});
