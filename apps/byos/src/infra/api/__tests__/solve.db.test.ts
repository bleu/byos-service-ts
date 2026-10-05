import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../../../test/setup.js";
import * as store from "../../storage.js";
import { createSolveRoute } from "../solve.js";

let ctx: TestContext;
let nonceCounter = 0n;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TRAMPOLINE = "0x4444444444444444444444444444444444441234" as Address;
const ORDER_UID = `0x${"ab".repeat(56)}`;

function sampleProposal(overrides?: Partial<store.ProposalInput>): store.ProposalInput {
	return {
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: ORDER_UID,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 950_000n,
		quoteBuyAmount: 1_000_000n,
		sellToken: SELL_TOKEN as Address,
		buyToken: BUY_TOKEN as Address,
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
		nonce: nonceCounter++,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
		sellTokenRefPrice: null,
		surplusTokenRefPrice: null,
		auctionGasPrice: null,
		clearingPrices: null,
		simulationBuyAmount: null,
		...overrides,
	};
}

function buildAuction(orderUid = ORDER_UID) {
	return {
		id: "1",
		effectiveGasPrice: "0",
		deadline: new Date(Date.now() + 60_000).toISOString(),
		surplusCapturingJitOrderOwners: [],
		orders: [
			{
				uid: orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: "1000000",
				fullSellAmount: "1000000",
				buyAmount: "700000", // order limit < simulationBuyAmount (800_000) → positive surplus
				fullBuyAmount: "700000",
				validTo: Math.floor(Date.now() / 1000) + 3600,
				kind: "sell",
				owner: "0x0000000000000000000000000000000000000001",
				partiallyFillable: false,
				preInteractions: [],
				postInteractions: [],
				sellTokenSource: "erc20",
				buyTokenDestination: "erc20",
				class: "market",
				appData: `0x${"00".repeat(32)}`,
				signingScheme: "eip712",
				signature: `0x${"ab".repeat(65)}`,
			},
		],
		tokens: {
			[SELL_TOKEN]: { referencePrice: String(10n ** 18n), availableBalance: "0", trusted: true },
			[BUY_TOKEN]: { referencePrice: String(10n ** 18n), availableBalance: "0", trusted: true },
		},
	};
}

function createSolveApp() {
	return new Hono().route(
		"/",
		createSolveRoute({ db: ctx.db, gasPriceRef: { value: 0n }, onAuditEvent: () => {} }),
	);
}

async function postSolve(app: Hono, body: unknown) {
	const res = await app.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.json() as Promise<{ solutions: Array<{ prices: Record<string, string> }> }>;
}

describe("/solve clearing price uses effectiveBuyAmount", () => {
	it("uses simulationBuyAmount as clearing price when it is lower than quoteBuyAmount", async () => {
		const quoteBuyAmount = 1_000_000n;
		const simulationBuyAmount = 800_000n; // route delivered less than quoted

		const { id } = await store.insert(ctx.db, sampleProposal({ quoteBuyAmount }));

		await store.resolveVerdict(ctx.db, id, {
			kind: "accept",
			simulation: {
				gasUsed: 100_000n,
				trampoline: TRAMPOLINE,
				sellToken: SELL_TOKEN as Address,
				buyToken: BUY_TOKEN as Address,
				simulationBuyAmount,
			},
		});

		const json = await postSolve(createSolveApp(), buildAuction());

		expect(json.solutions).toHaveLength(1);
		const prices = json.solutions[0]!.prices;
		// Clearing price for sellToken must use simulationBuyAmount (800_000),
		// not quoteBuyAmount (1_000_000).
		expect(prices[SELL_TOKEN]).toBe("800000");
		expect(prices[SELL_TOKEN]).not.toBe("1000000");
	});

	it("uses quoteBuyAmount as clearing price when simulationBuyAmount is higher", async () => {
		const quoteBuyAmount = 1_000_000n;
		const simulationBuyAmount = 1_050_000n; // route over-delivered — quote is still the commitment

		const { id } = await store.insert(
			ctx.db,
			sampleProposal({ quoteBuyAmount, orderUid: `0x${"cd".repeat(56)}` }),
		);

		await store.resolveVerdict(ctx.db, id, {
			kind: "accept",
			simulation: {
				gasUsed: 100_000n,
				trampoline: TRAMPOLINE,
				sellToken: SELL_TOKEN as Address,
				buyToken: BUY_TOKEN as Address,
				simulationBuyAmount,
			},
		});

		const json = await postSolve(createSolveApp(), buildAuction(`0x${"cd".repeat(56)}`));

		expect(json.solutions).toHaveLength(1);
		const prices = json.solutions[0]!.prices;
		// Over-delivery: effectiveBuyAmount falls back to quoteBuyAmount
		expect(prices[SELL_TOKEN]).toBe("1000000");
	});

	it("uses quoteBuyAmount as clearing price when simulationBuyAmount is null (pre-feature)", async () => {
		const quoteBuyAmount = 1_000_000n;
		const orderUid = `0x${"ef".repeat(56)}`;

		const { id } = await store.insert(ctx.db, sampleProposal({ quoteBuyAmount, orderUid }));

		// Activate via resolveVerdict, then clear simulationBuyAmount to simulate
		// a pre-feature proposal that was validated before this column existed.
		await store.resolveVerdict(ctx.db, id, {
			kind: "accept",
			simulation: {
				gasUsed: 100_000n,
				trampoline: TRAMPOLINE,
				sellToken: SELL_TOKEN as Address,
				buyToken: BUY_TOKEN as Address,
				simulationBuyAmount: quoteBuyAmount, // will be overwritten below
			},
		});

		// Null out the column directly to mimic a pre-feature row
		await ctx.db.execute(sql`UPDATE proposals SET simulation_buy_amount = NULL WHERE id = ${id}`);

		const json = await postSolve(createSolveApp(), buildAuction(orderUid));

		expect(json.solutions).toHaveLength(1);
		const prices = json.solutions[0]!.prices;
		// effectiveBuyAmount falls back to quoteBuyAmount when simulationBuyAmount is null
		expect(prices[SELL_TOKEN]).toBe("1000000");
	});
});
