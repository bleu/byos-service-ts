import { byosDomain } from "@byos/common";
import {
	type ByosClient,
	type CandidateOrder,
	type FyndProvider,
	OrderFilter,
	RequestBudget,
	SolveOrderbookClient,
} from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config.js";
import { FyndSubsolver } from "./fynd-subsolver.js";
import { createSolveApp } from "./solve-app.js";

const factory = "0x0000000000000000000000000000000000000001";
const sellToken = "0x0000000000000000000000000000000000000002";
const buyToken = "0x0000000000000000000000000000000000000003";

function order(index: number, buyAmount: string, kind = "sell") {
	return {
		uid: `0x${index.toString(16).padStart(112, "0")}`,
		sellToken,
		buyToken,
		sellAmount: "100",
		buyAmount,
		fullSellAmount: "100",
		fullBuyAmount: buyAmount,
		kind,
		class: "limit",
		validTo: 2000000000,
		sellTokenSource: "erc20",
		buyTokenDestination: "erc20",
	};
}

function setup() {
	const config = parseConfig({
		DISCOVERY_METHOD: "solve",
		SUBSOLVER_BEARER: "secret",
		BYOS_URL: "http://byos",
		RPC_URL: "http://rpc",
		SUBSOLVER_PRIVATE_KEY: "0x01",
		CHAIN_ID: "56",
		TRAMPOLINE_FACTORY: factory,
		GPV2_SETTLEMENT: factory,
		CLOSE_TO_EXECUTION_TOP_N: "1",
	});
	const client = new SolveOrderbookClient();
	const quote = vi.fn(async (_order: CandidateOrder) => null);
	const submit = vi.fn();
	const subsolver = new FyndSubsolver(
		config,
		client,
		{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
		{ ready: async () => true, quote } as unknown as FyndProvider,
		byosDomain(56, factory),
		async () => "0x",
		pino({ level: "silent" }),
		new RequestBudget(),
		new OrderFilter({ closeToExecutionTopN: config.closeToExecutionTopN }),
	);
	let now = 100n;
	const app = createSolveApp(client, "secret", () => subsolver.pollOnce(now++));
	const push = async (orders: ReturnType<typeof order>[], token = "secret") => {
		quote.mockClear();
		return app.request("/solve", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				id: String(now),
				deadline: "2030-01-01T00:00:00Z",
				effectiveGasPrice: "1",
				tokens: {
					[sellToken]: { referencePrice: "1000000000000000000" },
					[buyToken]: { referencePrice: "1000000000000000000" },
				},
				orders,
			}),
		});
	};
	const quotedUids = () => quote.mock.calls.map(([candidate]) => candidate.uid).sort();
	return { push, quotedUids, submit };
}

describe("solve discovery pipeline with mocked external services", () => {
	it("quotes the baseline top-N, then every new sell order alongside top-N", async () => {
		const { push, quotedUids, submit } = setup();
		const top = order(1, "90");
		const excluded = order(2, "50");
		const buy = order(3, "200", "buy");
		const fresh = order(4, "10");

		expect((await push([top, excluded, buy])).status).toBe(200);
		expect(quotedUids()).toEqual([top.uid]);

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedUids()).toEqual([top.uid, fresh.uid].sort());

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedUids()).toEqual([top.uid]);

		expect((await push([])).status).toBe(200);
		expect(quotedUids()).toEqual([]);

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedUids()).toEqual([top.uid, excluded.uid, fresh.uid].sort());
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not let an unauthorized push poison the previous-auction baseline", async () => {
		const { push, quotedUids } = setup();
		const top = order(1, "90");
		const fresh = order(2, "10");
		expect((await push([top])).status).toBe(200);
		expect((await push([top, fresh], "wrong")).status).toBe(401);
		expect(quotedUids()).toEqual([]);
		expect((await push([top, fresh])).status).toBe(200);
		expect(quotedUids()).toEqual([top.uid, fresh.uid].sort());
	});
});
