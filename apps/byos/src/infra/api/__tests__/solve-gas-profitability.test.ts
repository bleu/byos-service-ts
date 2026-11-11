import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type Candidate, CandidateStore } from "../../candidate-store.js";
import { createSolveRoute, type SolveConfig } from "../solve.js";
import type { SolveResponse } from "../types.js";

vi.mock("../../storage.js", () => ({
	publishAuctionGasPrice: vi.fn(async () => {}),
	allSubSolvers: vi.fn(async () => []),
	insertAsSubmitted: vi.fn(async () => {}),
	writeToLog: vi.fn(async () => {}),
}));

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TRAMPOLINE = "0x4444444444444444444444444444444444441234" as Address;
const ORDER_UID = `0x${"ab".repeat(56)}`;
const AUCTION_ID = 1;

let idCounter = 1;
let nonceCounter = 0n;

function sampleCandidate(overrides?: Partial<Candidate>): Candidate {
	return {
		id: idCounter++,
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
		auctionId: AUCTION_ID,
		gasUsed: 100_000n,
		trampoline: TRAMPOLINE,
		simulationBuyAmount: null,
		sellTokenRefPrice: "1000000000000000000",
		createdAt: new Date(),
		...overrides,
	};
}

function buildAuction(orderUid = ORDER_UID) {
	return {
		id: String(AUCTION_ID),
		effectiveGasPrice: "0",
		deadline: new Date().toISOString(),
		surplusCapturingJitOrderOwners: [],
		orders: [
			{
				uid: orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: "1000000",
				fullSellAmount: "1000000",
				buyAmount: "700000", // order limit < quoteBuyAmount (1_000_000) → positive surplus
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

function createSolveApp(candidateStore: CandidateStore, useGasProfitability?: boolean) {
	return new Hono().route(
		"/",
		createSolveRoute({
			db: {} as SolveConfig["db"],
			useGasProfitability,
			candidateStore,
			validator: {
				validate: async () => null,
				beginAuction: () => {},
				prefetchBalances: async () => {},
			},
			onAuditEvent: () => {},
		}),
	);
}

async function postSolve(app: Hono, body: unknown) {
	const res = await app.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.json() as Promise<SolveResponse>;
}

describe("/solve gas profitability", () => {
	it.each(["sell", "buy"] as const)(
		"returns a %s route with zero gas cut only when opted out",
		async (kind) => {
			for (const enabled of [undefined, true, false]) {
				const candidateStore = new CandidateStore();
				candidateStore.add(sampleCandidate());
				const auction = buildAuction();
				auction.effectiveGasPrice = "10"; // gas cost exceeds either order's surplus
				auction.orders[0]!.kind = kind;
				if (kind === "buy") {
					auction.orders[0]!.sellAmount = "1100000";
					auction.orders[0]!.fullSellAmount = "1100000";
					auction.orders[0]!.buyAmount = "1000000";
					auction.orders[0]!.fullBuyAmount = "1000000";
				}
				const { solutions } = await postSolve(createSolveApp(candidateStore, enabled), auction);
				expect(solutions).toHaveLength(enabled === false ? 1 : 0);
				if (enabled === false) {
					expect(solutions[0]!.trades[0]!.fee).toBe("0");
					expect(solutions[0]!.trades[0]!.executedAmount).toBe("1000000");
					expect(solutions[0]!.gas).toBe(130_000);
				}
			}
		},
	);

	it("still rejects a route below the signed limit with gas profitability disabled", async () => {
		const candidateStore = new CandidateStore();
		candidateStore.add(sampleCandidate({ quoteBuyAmount: 600_000n, minBuyAmount: 600_000n }));
		const { solutions } = await postSolve(createSolveApp(candidateStore, false), buildAuction());
		expect(solutions).toHaveLength(0);
	});
});
