/** Real-auction scenarios, including synchronous ingestion/validation failures. */
import { pad, type WalletClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	signAndSubmitProposal,
	submitProposalInAuction,
	submitProposalUntilTrade,
} from "./helpers/byos.js";
import { publicClient } from "./helpers/clients.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import { E2E_FIXTURES, fixtureWallet, SCENARIO_SUB_SOLVERS } from "./helpers/fixtures.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	cancelOrders,
	type GpvOrder,
	getAmountsOut,
	signAndSubmitOrder,
} from "./helpers/orderbook.js";
import { assertE2ePrerequisites } from "./helpers/prerequisites.js";
import { createTimingLog } from "./helpers/timing.js";

const SELL_AMOUNT = 1_000_000_000n;
const submitted: { wallet: WalletClient; uid: string }[] = [];
const traders = [
	ACCOUNTS.trader,
	ACCOUNTS.trader2,
	ACCOUNTS.trader3,
	ACCOUNTS.trader4,
	ACCOUNTS.trader5,
];
const subSolvers = Object.values(SCENARIO_SUB_SOLVERS);

beforeAll(async () => {
	const timing = createTimingLog("order scenarios setup");
	await Promise.all(
		Object.keys(SCENARIO_SUB_SOLVERS).map((name) => {
			const fixture = E2E_FIXTURES[name as keyof typeof E2E_FIXTURES];
			if (!fixture) throw new Error(`missing fixture ${name}`);
			return assertE2ePrerequisites(fixture);
		}),
	);
	timing("seeded scenario identities verified");
});
afterAll(async () => {
	const timing = createTimingLog("order scenarios cleanup");
	await Promise.all(submitted.map(({ wallet, uid }) => cancelOrders(wallet, [uid])));
	timing("scenario orders cleaned up");
});

async function scenario(index: number, timing: (step: string) => void, buyAmount = 1n) {
	const trader = traders[index];
	const subSolver = subSolvers[index];
	if (!trader || !subSolver) throw new Error("missing scenario identity");
	const wallet = fixtureWallet(trader);
	const [, quoteBuyAmount] = await getAmountsOut(publicClient, SELL_AMOUNT, [
		CONTRACTS.usdc,
		CONTRACTS.weth,
	]);
	if (quoteBuyAmount === undefined) throw new Error("missing quote");
	const minBuyAmount = (quoteBuyAmount * 9990n) / 10000n;
	const order: GpvOrder = {
		sellToken: CONTRACTS.usdc,
		buyToken: CONTRACTS.weth,
		receiver: trader.address,
		sellAmount: SELL_AMOUNT,
		buyAmount,
		validTo: Math.floor(Date.now() / 1000) + 600,
		appData: pad("0x00", { size: 32 }),
		feeAmount: 0n,
		kind: "sell",
		partiallyFillable: false,
		sellTokenBalance: "erc20",
		buyTokenBalance: "erc20",
	};
	const uid = await signAndSubmitOrder(wallet, order);
	submitted.push({ wallet, uid });
	timing(`quote fetched and order accepted: ${uid}`);
	return {
		walletClient: fixtureWallet(subSolver),
		orderUid: uid,
		sellToken: CONTRACTS.usdc,
		buyToken: CONTRACTS.weth,
		sellAmount: SELL_AMOUNT,
		minBuyAmount,
		quoteBuyAmount,
		interactions: buildSellInteractions(CONTRACTS.usdc, CONTRACTS.weth, SELL_AMOUNT, minBuyAmount),
	};
}

describe.concurrent("order scenarios", () => {
	it("happy path: valid order and proposal settle", async () => {
		const timing = createTimingLog("scenario happy path");
		await submitProposalUntilTrade(await scenario(0, timing), 90_000, timing);
		timing("settlement verified");
	});
	it("simFailed: impossible swap is rejected inline", async () => {
		const timing = createTimingLog("scenario simulation rejection");
		const params = await scenario(1, timing);
		params.interactions = buildSellInteractions(
			CONTRACTS.usdc,
			CONTRACTS.weth,
			SELL_AMOUNT,
			params.quoteBuyAmount * 1000n,
		);
		const { response } = await submitProposalInAuction(params, timing);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			kind: "ProposalRejected",
			description: "SimFailed",
		});
		timing("simulation rejection verified");
	});
	it("expired: an already expired proposal is rejected at ingestion", async () => {
		const timing = createTimingLog("scenario expiry");
		const params = await scenario(2, timing);
		const { response } = await signAndSubmitProposal(
			{ ...params, validUntilOffset: -1 },
			{ returnFailure: true },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ kind: "ProposalExpired" });
		timing("expired proposal rejected without waiting for a background tick");
	});
	it("invalid order: past validTo is rejected at submission", async () => {
		const timing = createTimingLog("scenario invalid order");
		const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sellToken: CONTRACTS.usdc,
				buyToken: CONTRACTS.weth,
				receiver: ACCOUNTS.trader.address,
				sellAmount: SELL_AMOUNT.toString(),
				buyAmount: "1",
				validTo: Math.floor(Date.now() / 1000) - 60,
				appData: pad("0x00", { size: 32 }),
				feeAmount: "0",
				kind: "sell",
				partiallyFillable: false,
				sellTokenBalance: "erc20",
				buyTokenBalance: "erc20",
				from: ACCOUNTS.trader.address,
				signature: pad("0x00", { size: 65 }),
				signingScheme: "eip712",
			}),
		});
		expect(resp.status).toBe(400);
		timing("invalid order rejected");
	});
	it("unprofitable: a route at the order limit is rejected inline", async () => {
		const timing = createTimingLog("scenario unprofitable");
		const [, quote] = await getAmountsOut(publicClient, SELL_AMOUNT, [
			CONTRACTS.usdc,
			CONTRACTS.weth,
		]);
		if (quote === undefined) throw new Error("missing quote");
		// Other scenarios trade against this pool concurrently. Leave output margin
		// so a stale AMM quote does not fail simulation before the profitability gate.
		// The signed quote still equals the order limit, leaving zero scored surplus
		// even when the route delivers more than quoted.
		const orderLimit = (quote * 95n) / 100n;
		const params = await scenario(3, timing, orderLimit);
		params.quoteBuyAmount = orderLimit;
		params.minBuyAmount = orderLimit;
		params.interactions = buildSellInteractions(
			CONTRACTS.usdc,
			CONTRACTS.weth,
			SELL_AMOUNT,
			orderLimit,
		);
		const { response } = await submitProposalInAuction(params, timing);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			kind: "ProposalRejected",
			description: "Unprofitable",
		});
		timing("profitability rejection verified");
	});
	it("filled order: late proposals are rejected by the auction admission gate", async () => {
		const timing = createTimingLog("scenario late proposal");
		const params = await scenario(4, timing);
		await submitProposalUntilTrade(params, 90_000, timing);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const { response } = await signAndSubmitProposal(
				{ ...params, walletClient: fixtureWallet(SCENARIO_SUB_SOLVERS.lateSubSolver) },
				{ returnFailure: true },
			);
			const error = (await response.json()) as { kind: string };
			if (error.kind === "NoActiveAuction") {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			expect(response.status).toBe(400);
			expect(error.kind).toBe("UnknownOrder");
			timing("filled order rejected before simulation");
			return;
		}
		throw new Error("No auction opened to check filled-order admission");
	});
});
