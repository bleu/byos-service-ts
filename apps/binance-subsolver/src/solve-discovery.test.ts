import { byosDomain } from "@byos/common";
import {
	type ByosClient,
	ByosRateLimitError,
	createSolveApp,
	OrderFilter,
	RequestBudget,
	SolveOrderbookClient,
} from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BinanceClient } from "./binance-client.js";
import { BinanceSubsolver } from "./binance-subsolver.js";
import { parseConfig } from "./config.js";

const factory = "0x0000000000000000000000000000000000000001";
const sellToken = "0x0000000000000000000000000000000000000002";
const buyToken = "0x0000000000000000000000000000000000000003";

function order(index: number, buyAmount: string, kind = "sell") {
	return {
		uid: `0x${index.toString(16).padStart(112, "0")}`,
		sellToken,
		buyToken,
		sellAmount: String(100 + index),
		buyAmount,
		fullSellAmount: String(100 + index),
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
		BINANCE_API_KEY: "key",
		BINANCE_SECRET_KEY: "secret",
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
	const quote = vi.fn(async (_sellToken: string, _buyToken: string, _amount: bigint) => []);
	const submit = vi.fn();
	const proposals = vi.fn(async () => []);
	const subsolver = new BinanceSubsolver(
		config,
		client,
		{ proposals, isTerminal: () => false, submit } as unknown as ByosClient,
		{ getQuotes: quote } as unknown as BinanceClient,
		factory,
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
	const quotedSellAmounts = () => quote.mock.calls.map(([, , amount]) => amount.toString()).sort();
	return { push, quotedSellAmounts, submit, subsolver, proposals };
}

describe("solve discovery pipeline with mocked external services", () => {
	it("updates the selection snapshot while BYOS is backing off", async () => {
		vi.useFakeTimers();
		try {
			const { push, quotedSellAmounts, proposals, subsolver } = setup();
			const top = order(1, "90");
			const fresh = order(4, "10");
			await push([top]);
			proposals.mockRejectedValueOnce(new ByosRateLimitError(1000));
			await subsolver.synchronize(100n);
			await push([top, fresh]);
			expect(quotedSellAmounts()).toEqual([]);
			vi.advanceTimersByTime(1001);
			await push([top, fresh]);
			expect(quotedSellAmounts()).toEqual(["101"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("quotes the baseline top-N, then every new sell order alongside top-N", async () => {
		const { push, quotedSellAmounts, submit } = setup();
		const top = order(1, "90");
		const excluded = order(2, "50");
		const buy = order(3, "200", "buy");
		const fresh = order(4, "10");

		expect((await push([top, excluded, buy])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual(["101"]);

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual(["101", "104"].sort());

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual(["101"]);

		expect((await push([])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual([]);

		expect((await push([top, excluded, buy, fresh])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual(["101", "102", "104"].sort());
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not let an unauthorized push poison the previous-auction baseline", async () => {
		const { push, quotedSellAmounts } = setup();
		const top = order(1, "90");
		const fresh = order(4, "10");
		expect((await push([top])).status).toBe(200);
		expect((await push([top, fresh], "wrong")).status).toBe(401);
		expect(quotedSellAmounts()).toEqual([]);
		expect((await push([top, fresh])).status).toBe(200);
		expect(quotedSellAmounts()).toEqual(["101", "104"].sort());
	});
});
