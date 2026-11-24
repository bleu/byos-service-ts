import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuctionWork } from "../auction-work.js";
import { FyndProvider } from "../fynd-provider.js";
import { createFyndRoutingClient } from "../fynd-routing-client.js";

const tokenIn = "0x0000000000000000000000000000000000000001" as const;
const tokenOut = "0x0000000000000000000000000000000000000002" as const;
const router = "0x0000000000000000000000000000000000000003" as const;
const params = {
	order: {
		tokenIn,
		tokenOut,
		amount: 100n,
		side: "sell" as const,
		sender: tokenIn,
		receiver: tokenOut,
	},
	options: {
		encodingOptions: { slippage: 0.005, transferType: "transfer_from" as const },
		routeFilter: { excludePools: ["pool-0"] },
	},
};
const response = () => ({
	orders: [
		{
			order_id: "quote-1",
			status: "success",
			amount_in: "100",
			amount_out: "120",
			gas_estimate: "12345",
			block: { number: 1, hash: "0x01", timestamp: Math.floor(Date.now() / 1000) },
			route: {
				swaps: [
					{
						component_id: "pool-1",
						protocol: "pancakeswap_v3",
						token_in: tokenIn,
						token_out: tokenOut,
						amount_in: "100",
						amount_out: "120",
						gas_estimate: "12345",
					},
				],
			},
			transaction: { to: router, value: "0", data: "0xab" },
			fee_breakdown: {
				router_fee: "0",
				client_fee: "0",
				max_slippage: "10",
				min_amount_received: "110",
			},
		},
	],
});
const scope = (ms = 10000) =>
	createAuctionWork({
		auctionId: "1",
		deadlineMs: Date.now() + ms,
		receivedAtMs: Date.now(),
		deadlineBufferMs: 1000,
	});
const hangingFetch: typeof fetch = async (input) =>
	new Promise<Response>((_resolve, reject) => {
		const request = input as Request;
		request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
	});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("deadline-aware Fynd routing transport", () => {
	it("serializes route filters and decimal slippage and converts the encoded quote", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response()));
		vi.stubGlobal("fetch", fetch);
		const context = scope();
		try {
			const quote = await createFyndRoutingClient("http://fynd").quote(params, context.work);
			expect(quote).toMatchObject({
				amountIn: 100n,
				transaction: { to: router, data: "0xab", value: 0n },
				feeBreakdown: { minAmountReceived: 110n },
				route: { swaps: [{ componentId: "pool-1", amountIn: 100n }] },
			});
			const request = fetch.mock.calls[0]?.[0] as Request;
			expect(await request.json()).toMatchObject({
				orders: [{ amount: "100", receiver: tokenOut }],
				options: {
					timeout_ms: 5000,
					encoding_options: { slippage: "0.005", transfer_type: "transfer_from" },
					route_filter: { exclude_pools: ["pool-0"] },
				},
			});
		} finally {
			context.dispose();
		}
	});

	it("aborts the actual HTTP request on supersession", async () => {
		const fetch = vi.fn(hangingFetch);
		vi.stubGlobal("fetch", fetch);
		const context = scope();
		try {
			const quote = createFyndRoutingClient("http://fynd").quote(params, context.work);
			const failed = expect(quote).rejects.toThrow("Auction superseded");
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
			context.abort();
			await failed;
			expect((fetch.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
		} finally {
			context.dispose();
		}
	});

	it("keeps a completed alternative when a later HTTP quote hits the deadline", async () => {
		vi.useFakeTimers();
		let count = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (...args) => {
				if (++count === 1) return Response.json(response());
				return hangingFetch(...args);
			}),
		);
		const context = scope(1500);
		const client = createFyndRoutingClient("http://fynd");
		const provider = new FyndProvider({
			chainId: 56,
			trampoline: tokenIn,
			settlement: tokenOut,
			wrappedNative: tokenOut,
			client: {
				...client,
				info: async () => ({
					chainId: 56,
					routerAddress: router,
					permit2Address: router,
					jitRouterAddress: null,
					toAddress: router,
				}),
			},
		});
		try {
			const quoting = provider.quoteMany(
				{
					uid: "0x01",
					chainId: 56,
					sellToken: tokenIn,
					buyToken: tokenOut,
					remainingSell: 100n,
					scaledLimitBuy: 100n,
				},
				context.work,
			);
			await vi.advanceTimersByTimeAsync(401);
			expect(await quoting).toHaveLength(1);
			expect(count).toBe(2);
		} finally {
			context.abort();
			context.dispose();
		}
	});

	it("rejects malformed wire amounts instead of submitting an unvalidated route", async () => {
		const bad = response();
		bad.orders[0]!.amount_out = "not-a-number";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(bad)),
		);
		const context = scope();
		try {
			await expect(
				createFyndRoutingClient("http://fynd").quote(params, context.work),
			).rejects.toThrow();
		} finally {
			context.dispose();
		}
	});
});
