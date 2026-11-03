import { BUY_ETH_ADDRESS, TrampolineAbi } from "@byos/common";
import { Hono } from "hono";
import { type Address, decodeFunctionData, type Hex, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../../../test/setup.js";
import { nativeBuyAuctionOrder } from "../../blockchain/__tests__/fixtures/native-buy-order.js";
import { type Candidate, CandidateStore } from "../../candidate-store.js";
import * as store from "../../storage.js";
import { createSolveRoute } from "../solve.js";

let ctx: TestContext;

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

function createSolveApp(candidateStore: CandidateStore) {
	return new Hono().route(
		"/",
		createSolveRoute({
			db: ctx.db,
			candidateStore,
			validator: {
				validate: async () => null,
				beginAuction: () => {},
				prefetchBalances: async () => {},
			} as any,
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
	return res.json() as Promise<{
		solutions: Array<{
			prices: Record<string, string>;
			interactions: Array<{ target: string; callData: Hex; value: string }>;
		}>;
	}>;
}

describe("/solve clearing price uses effectiveBuyAmount", () => {
	it.each([false, true])(
		"preserves the signed buy token and leaves unwrapping to the driver (native output: %s)",
		async (nativeOutput) => {
			const sellToken = nativeBuyAuctionOrder.sellToken.toLowerCase() as Address;
			const buyToken = nativeBuyAuctionOrder.buyToken.toLowerCase() as Address;
			const candidateStore = new CandidateStore();
			candidateStore.add(
				sampleCandidate({
					orderUid: nativeBuyAuctionOrder.uid,
					sellToken,
					buyToken: nativeOutput ? (BUY_ETH_ADDRESS as Address) : buyToken,
					sellAmount: BigInt(nativeBuyAuctionOrder.fullSellAmount),
					minBuyAmount: 2_000_000_000_000_000n,
					quoteBuyAmount: 2_000_000_000_000_000n,
				}),
			);
			const json = await postSolve(createSolveApp(candidateStore), {
				...buildAuction(),
				orders: [{ ...nativeBuyAuctionOrder, sellToken, buyToken }],
				tokens: {
					[sellToken]: { referencePrice: String(10n ** 18n), availableBalance: "0", trusted: true },
					[buyToken]: { referencePrice: String(10n ** 18n), availableBalance: "0", trusted: true },
				},
			});
			expect(json.solutions).toHaveLength(1);
			const solution = json.solutions[0]!;
			expect(solution.prices[buyToken]).toBe(nativeBuyAuctionOrder.fullSellAmount);
			// Native proposals wrap their delivery; the driver alone adds the unwrap.
			expect(solution.interactions).toHaveLength(nativeOutput ? 3 : 2);
			expect(solution.interactions.map((i) => i.target.toLowerCase())).toEqual([
				sellToken,
				TRAMPOLINE.toLowerCase(),
				...(nativeOutput ? [buyToken] : []),
			]);
			const execute = decodeFunctionData({
				abi: TrampolineAbi,
				data: solution.interactions[1]!.callData,
			});
			expect(execute.args[0].buyToken.toLowerCase()).toBe(
				nativeOutput ? BUY_ETH_ADDRESS.toLowerCase() : buyToken,
			);
			expect(execute.args[2]).toBe(`0x${"ee".repeat(65)}`);
			if (nativeOutput) {
				const wrap = solution.interactions[2]!;
				expect(wrap.value).toBe("2000000000000000");
				expect(
					decodeFunctionData({ abi: parseAbi(["function deposit() payable"]), data: wrap.callData })
						.functionName,
				).toBe("deposit");
			}
		},
	);

	it("uses simulationBuyAmount as clearing price when it is lower than quoteBuyAmount", async () => {
		const quoteBuyAmount = 1_000_000n;
		const simulationBuyAmount = 800_000n; // route delivered less than quoted

		const candidateStore = new CandidateStore();
		const candidate = sampleCandidate({ quoteBuyAmount, simulationBuyAmount });
		candidateStore.add(candidate);

		const json = await postSolve(createSolveApp(candidateStore), buildAuction());

		expect(json.solutions).toHaveLength(1);
		expect((await store.get(ctx.db, candidate.id))?.settlementPenaltyCap).toBe(400n);
		const prices = json.solutions[0]!.prices;
		// Clearing price for sellToken must use simulationBuyAmount (800_000),
		// not quoteBuyAmount (1_000_000).
		expect(prices[SELL_TOKEN]).toBe("800000");
		expect(prices[SELL_TOKEN]).not.toBe("1000000");
	});

	it("uses quoteBuyAmount as clearing price when simulationBuyAmount is higher", async () => {
		const quoteBuyAmount = 1_000_000n;
		const simulationBuyAmount = 1_050_000n; // route over-delivered — quote is still the commitment

		const candidateStore = new CandidateStore();
		const candidate = sampleCandidate({
			quoteBuyAmount,
			simulationBuyAmount,
			orderUid: `0x${"cd".repeat(56)}`,
		});
		candidateStore.add(candidate);

		const json = await postSolve(
			createSolveApp(candidateStore),
			buildAuction(`0x${"cd".repeat(56)}`),
		);

		expect(json.solutions).toHaveLength(1);
		const prices = json.solutions[0]!.prices;
		// Over-delivery: effectiveBuyAmount falls back to quoteBuyAmount
		expect(prices[SELL_TOKEN]).toBe("1000000");
	});

	it("uses quoteBuyAmount as clearing price when simulationBuyAmount is null", async () => {
		const quoteBuyAmount = 1_000_000n;
		const orderUid = `0x${"ef".repeat(56)}`;

		const candidateStore = new CandidateStore();
		const candidate = sampleCandidate({
			quoteBuyAmount,
			simulationBuyAmount: null,
			orderUid,
		});
		candidateStore.add(candidate);

		const json = await postSolve(createSolveApp(candidateStore), buildAuction(orderUid));

		expect(json.solutions).toHaveLength(1);
		const prices = json.solutions[0]!.prices;
		// effectiveBuyAmount falls back to quoteBuyAmount when simulationBuyAmount is null
		expect(prices[SELL_TOKEN]).toBe("1000000");
	});
});
