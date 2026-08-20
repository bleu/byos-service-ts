// Ported from the Rust /solve tests (byos infra/api/mod.rs). Rust gives each
// test a fresh database; this suite shares one, so every test owns a distinct
// order UID and, where it matters, a distinct auction id.
import type { Auction, SolveResponse } from "@byos/byos/src/infra/api/types.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { encodeTrampolineInteractions } from "@byos/common";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, seedProposal, type TestApp } from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

const SELL_TOKEN = `0x${"11".repeat(20)}` as Address;
const BUY_TOKEN = `0x${"22".repeat(20)}` as Address;
const TRAMPOLINE = `0x${"55".repeat(20)}` as Address;

const uid = (byte: string) => `0x${byte.repeat(56)}`;

/** Rust's auction_json: one order on the parity-priced token pair. */
function auctionJson(
	orderUid: string,
	kind: "sell" | "buy",
	sellAmount: string,
	buyAmount: string,
	gasPrice: string,
): Auction {
	return {
		id: "1",
		tokens: {
			[SELL_TOKEN]: {
				referencePrice: "1000000000000000000",
				availableBalance: "0",
				trusted: false,
			},
			[BUY_TOKEN]: {
				referencePrice: "1000000000000000000",
				availableBalance: "0",
				trusted: false,
			},
		},
		orders: [
			{
				uid: orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount,
				fullSellAmount: sellAmount,
				buyAmount,
				fullBuyAmount: buyAmount,
				validTo: 4294967295,
				kind,
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
		effectiveGasPrice: gasPrice,
		deadline: "2099-01-01T00:00:00Z",
	};
}

async function postSolve(auction: Auction): Promise<SolveResponse> {
	const resp = await app.internalApp.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auction),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

/** Rust's insert_active_proposal(_with_gas). */
async function seedActive(
	orderUid: string,
	sellAmount: bigint,
	minBuyAmount: bigint,
	gasUsed = 200_000n,
): Promise<number> {
	return seedProposal(app.ctx.db, {
		orderUid,
		sellAmount,
		minBuyAmount,
		quoteBuyAmount: minBuyAmount,
		gasUsed,
		trampoline: "0x0000000000000000000000000000000000000000" as Address,
	});
}

/** Both tokens priced at parity and 1 wei per gas, so the cut in sell-token
 * atoms is just the effective gas: 200_000 simulated plus the buffer. */
const CUT_AT_PARITY = 230_000n;

describe("/solve economics", () => {
	it("sell order prices are cross-multiplied", async () => {
		const u = uid("e1");
		await seedActive(u, 1_000n, 950n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		expect(solutions).toHaveLength(1);
		// sell_token price = proposal.buy_amount, buy_token price = proposal.sell_amount
		expect(solutions[0]?.prices[SELL_TOKEN]).toBe("950");
		expect(solutions[0]?.prices[BUY_TOKEN]).toBe("1000");
	});

	it("sell order executed amount is sell", async () => {
		const u = uid("e2");
		await seedActive(u, 1_000n, 950n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		expect(solutions[0]?.trades[0]?.executedAmount).toBe("1000");
	});

	it("buy order executed amount is buy", async () => {
		const u = uid("e3");
		await seedActive(u, 950n, 900n);

		const { solutions } = await postSolve(auctionJson(u, "buy", "1000", "900", "0"));
		expect(solutions[0]?.trades[0]?.executedAmount).toBe("900");
	});

	// The driver checks executed + fee == order.sellAmount on a sell order,
	// and rejects a solution that declares no fee at all.
	it("declares the gas cut on a sell order", async () => {
		const u = uid("e4");
		await seedActive(u, 1_000_000_000n, 1_000_000_000n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000000000", "900000000", "1"));
		const trade = solutions[0]?.trades[0];
		expect(trade?.fee).toBe(CUT_AT_PARITY.toString());
		expect(trade?.executedAmount).toBe((1_000_000_000n - CUT_AT_PARITY).toString());
		expect(BigInt(trade?.executedAmount ?? "0") + BigInt(trade?.fee ?? "0")).toBe(1_000_000_000n);
	});

	// A buy order's cut rides alongside an unchanged execution.
	it("declares the gas cut on a buy order", async () => {
		const u = uid("e5");
		await seedActive(u, 950_000_000n, 900_000_000n);

		const { solutions } = await postSolve(auctionJson(u, "buy", "1000000000", "900000000", "1"));
		const trade = solutions[0]?.trades[0];
		expect(trade?.executedAmount).toBe("900000000");
		expect(trade?.fee).toBe(CUT_AT_PARITY.toString());
	});

	// If the cut ever moved the price vector, encode_settle would stop
	// producing the transaction ADR-0012 simulated.
	it("clearing prices are unchanged by the cut", async () => {
		const u = uid("e6");
		await seedActive(u, 1_000_000_000n, 1_000_000_000n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000000000", "900000000", "1"));
		expect(solutions[0]?.prices[SELL_TOKEN]).toBe("1000000000");
		expect(solutions[0]?.prices[BUY_TOKEN]).toBe("1000000000");
	});

	// The score alone will not catch a breach: at parity it sees 300_000 wei
	// of surplus against a 230_000 wei gas bill and says yes, while the cut
	// costs the user 460_000 buy-token atoms and breaks their limit.
	it("skips a proposal whose cut breaches the signed limit", async () => {
		const u = uid("e7");
		await seedActive(u, 1_000_000_000n, 2_000_000_000n);

		const thin = await postSolve(auctionJson(u, "sell", "1000000000", "1999700000", "1"));
		expect(
			thin.solutions,
			"a cut that breaches the signed buy amount must not be bid",
		).toHaveLength(0);

		const fat = await postSolve(auctionJson(u, "sell", "1000000000", "1990000000", "1"));
		expect(
			fat.solutions,
			"the same proposal against a limit with room for the cut must bid",
		).toHaveLength(1);
	});

	// The cut is checked per proposal, before the winner is picked, so a
	// breach costs us that proposal and not the whole order.
	it("falls back to the runner-up when the best cut breaches", async () => {
		const u = uid("e8");
		// Cut 530_000, score 470_000, delivers 1_998_940_000 — under the limit.
		await seedActive(u, 1_000_000_000n, 2_000_000_000n, 500_000n);
		// Cut 130_000, score 270_000, delivers 1_999_140_078 — over it.
		await seedActive(u, 1_000_000_000n, 1_999_400_000n, 100_000n);

		const tight = await postSolve(auctionJson(u, "sell", "1000000000", "1999000000", "1"));
		expect(tight.solutions, "the runner-up still deserves a bid").toHaveLength(1);
		expect(
			tight.solutions[0]?.trades[0]?.fee,
			"the surviving bid must be the runner-up, not the higher-scoring proposal",
		).toBe("130000");
		expect(tight.solutions[0]?.trades[0]?.executedAmount).toBe("999870000");

		// Same two proposals, a limit with room for both cuts: the fat route
		// wins on score, which is what makes the run above a fallback.
		const loose = await postSolve(auctionJson(u, "sell", "1000000000", "1990000000", "1"));
		expect(loose.solutions[0]?.trades[0]?.fee).toBe("530000");
	});

	// The driver's settlement budget: simulated gas plus the scoring buffer.
	it("reports the effective gas on the solution", async () => {
		const u = uid("e9");
		await seedActive(u, 1_000_000_000n, 1_000_000_000n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000000000", "900000000", "1"));
		expect(solutions[0]?.gas).toBe(Number(CUT_AT_PARITY));
	});

	// An Active proposal with no simulated gas cannot be priced.
	it("skips a proposal that has not been simulated", async () => {
		const u = uid("ea");
		await seedProposal(app.ctx.db, {
			orderUid: u,
			sellAmount: 1_000_000_000n,
			minBuyAmount: 1_000_000_000n,
			quoteBuyAmount: 1_000_000_000n,
			gasUsed: null,
			trampoline: "0x0000000000000000000000000000000000000000" as Address,
		});

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000000000", "900000000", "1"));
		expect(solutions).toHaveLength(0);
	});

	it("does not bid when the surplus token is unpriced", async () => {
		const u = uid("eb");
		await seedActive(u, 1_000_000_000n, 1_000_000_000n);

		// Sell order: the surplus is in the buy token.
		const auction = auctionJson(u, "sell", "1000000000", "900000000", "1");
		auction.tokens[BUY_TOKEN] = { referencePrice: null, availableBalance: "0", trusted: false };
		const { solutions } = await postSolve(auction);
		expect(solutions).toHaveLength(0);
	});

	// The cut is in the sell token, so an unpriced sell token cannot be cut,
	// and bidding without one means paying the gas ourselves.
	it("does not bid when the sell token is unpriced", async () => {
		const u = uid("ec");
		await seedActive(u, 1_000_000_000n, 1_000_000_000n);

		const auction = auctionJson(u, "sell", "1000000000", "900000000", "1");
		auction.tokens[SELL_TOKEN] = { referencePrice: null, availableBalance: "0", trusted: false };
		const { solutions } = await postSolve(auction);
		expect(solutions).toHaveLength(0);
	});

	// Gas equal to surplus scores zero, and zero does not bid.
	it("does not bid when gas exactly equals the surplus", async () => {
		const u = uid("ed");
		// Surplus at parity pricing is 230_000 wei, the same as the gas bill.
		await seedActive(u, 1_000_000_000n, 900_230_000n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000000000", "900000000", "1"));
		expect(solutions).toHaveLength(0);
	});

	it("selects best of N proposals", async () => {
		const u = uid("ee");
		await seedActive(u, 1_000n, 920n);
		await seedActive(u, 1_000n, 950n);

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		expect(solutions).toHaveLength(1);
		// Best proposal has buy_amount=950, which becomes the sell_token price.
		expect(solutions[0]?.prices[SELL_TOKEN]).toBe("950");
	});

	it("records the winning solution for notify attribution", async () => {
		const u = uid("ef");
		await seedActive(u, 1_000n, 950n);

		const auction = auctionJson(u, "sell", "1000", "900", "0");
		auction.id = "77";
		const { solutions } = await postSolve(auction);
		expect(solutions).toHaveLength(1);

		const attributed = await store.solutionProposals(app.ctx.db, 77, [1]);
		expect(
			attributed,
			"a returned solution must be attributable via the solutions table",
		).toHaveLength(1);
		expect(attributed[0]?.orderUid).toBe(u);
	});

	// An Executing proposal is frozen out of /solve — its balances are about
	// to be consumed by the in-flight settlement.
	it("never offers an executing proposal", async () => {
		const u = uid("f1");
		await seedProposal(app.ctx.db, {
			orderUid: u,
			gasUsed: 200_000n,
			trampoline: "0x0000000000000000000000000000000000000000" as Address,
			status: "executing",
			sellAmount: 1_000n,
			minBuyAmount: 950n,
			quoteBuyAmount: 950n,
		});

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		expect(solutions).toHaveLength(0);
	});

	// The driver keys its /notify attribution on solution ids (ADR-0013), so
	// a duplicate would misattribute a settlement.
	it("each order in an auction gets its own numbered solution", async () => {
		const first = uid("f2");
		const second = uid("f3");
		await seedActive(first, 1_000n, 950n);
		await seedProposal(app.ctx.db, {
			orderUid: second,
			sellAmount: 2_000n,
			minBuyAmount: 1_900n,
			quoteBuyAmount: 1_900n,
			gasUsed: 200_000n,
			trampoline: TRAMPOLINE,
		});

		const auction = auctionJson(first, "sell", "1000", "900", "0");
		const secondOrder = {
			...auction.orders[0]!,
			uid: second,
			sellAmount: "2000",
			fullSellAmount: "2000",
			buyAmount: "1800",
			fullBuyAmount: "1800",
		};
		auction.orders = [auction.orders[0]!, secondOrder];

		const { solutions } = await postSolve(auction);
		expect(solutions, "each order must be scored on its own").toHaveLength(2);
		expect(
			solutions.map((s) => s.id),
			"ids must be distinct — the driver attributes notifications by them",
		).toEqual([1, 2]);

		// Each solution must carry the amounts of its own order, not the other's.
		expect(solutions[0]?.trades[0]?.executedAmount).toBe("1000");
		expect(solutions[1]?.trades[0]?.executedAmount).toBe("2000");
	});

	// The encoder itself is covered in @byos/common; what was not covered is
	// the buildSolution call site feeding it. A reference encoding built from
	// explicitly-correct arguments catches swapped tokens or a wrong target.
	it("a solution wraps the route in the two trampoline interactions", async () => {
		const u = uid("f4");
		const route = [
			{
				target: `0x${"33".repeat(20)}` as Address,
				value: 0n,
				callData: "0x095ea7b3deadbeef" as Hex,
			},
			{
				target: `0x${"44".repeat(20)}` as Address,
				value: 7n,
				callData: "0x128acb08cafe" as Hex,
			},
		];
		const signature = `0x${"11".repeat(65)}` as Hex;
		await seedProposal(app.ctx.db, {
			orderUid: u,
			sellAmount: 1_000n,
			minBuyAmount: 950n,
			quoteBuyAmount: 950n,
			gasUsed: 200_000n,
			trampoline: TRAMPOLINE,
			interactions: route,
			signature,
		});

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		const interactions = solutions[0]?.interactions;
		expect(
			interactions,
			"transfer then execute, and nothing else (contracts ADR-0003)",
		).toHaveLength(2);

		const [expectedTransfer, expectedExecute] = encodeTrampolineInteractions(
			TRAMPOLINE,
			SELL_TOKEN,
			{
				orderUidHash: keccak256(u as Hex),
				sellAmount: 1_000n,
				minBuyAmount: 950n,
				quoteBuyAmount: 950n,
				validUntil: 2n ** 40n,
				nonce: 1n,
			},
			route,
			BUY_TOKEN,
			signature,
		);

		// 1. sellToken.transfer(trampoline, sellAmount)
		expect(interactions?.[0]?.target.toLowerCase()).toBe(expectedTransfer.target.toLowerCase());
		expect(interactions?.[0]?.callData).toBe(expectedTransfer.callData);
		expect(interactions?.[0]?.internalize, "internalizing would skip the funding transfer").toBe(
			false,
		);
		// 2. trampoline.execute(proposal, route, sellToken, buyToken, signature)
		expect(interactions?.[1]?.target.toLowerCase()).toBe(expectedExecute.target.toLowerCase());
		expect(interactions?.[1]?.callData).toBe(expectedExecute.callData);
	});

	// A proposal only reaches /solve unresolved if the validator accepted it
	// without deriving the trampoline. It has to cost us the bid rather than
	// emit a solution whose transfer goes nowhere.
	it("a proposal without a resolved trampoline is not offered", async () => {
		const u = uid("f5");
		await seedProposal(app.ctx.db, {
			orderUid: u,
			sellAmount: 1_000n,
			minBuyAmount: 950n,
			quoteBuyAmount: 950n,
			gasUsed: 200_000n,
			trampoline: null,
		});

		const { solutions } = await postSolve(auctionJson(u, "sell", "1000", "900", "0"));
		expect(solutions, "a proposal with no trampoline must not be bid").toHaveLength(0);
	});
});
