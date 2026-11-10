import { BUY_ETH_ADDRESS } from "@byos/common";
import type { FyndClient } from "@kayibal/fynd-client";
import { describe, expect, it, vi } from "vitest";
import { FyndConfigurationError, FyndProvider } from "../fynd-provider.js";
import type { CandidateOrder } from "../provider.js";

const router = "0x0000000000000000000000000000000000000003" as const;
const wrappedNative = "0x0000000000000000000000000000000000000009" as const;
const client = {
	info: async () => ({ chainId: 56, routerAddress: router, permit2Address: router }),
	health: async () => ({ healthy: true, lastUpdateMs: 1, numSolverPools: 1 }),
	quote: async () => ({
		orderId: "quote-1",
		status: "success" as const,
		backend: "fynd" as const,
		amountIn: 100n,
		amountOut: 120n,
		gasEstimate: 1n,
		route: { swaps: [] },
		block: { number: 1, hash: "0x", timestamp: 100 },
		tokenOut: "0x0000000000000000000000000000000000000002" as const,
		receiver: "0x0000000000000000000000000000000000000004" as const,
		transaction: { to: router, value: 0n, data: "0xdead" as const },
		feeBreakdown: { routerFee: 0n, clientFee: 0n, maxSlippage: 0n, minAmountReceived: 110n },
	}),
};

describe("FyndProvider", () => {
	it.each([0, 50, 100, 10_000])(
		"uses the guaranteed minimum for both proposal amounts with %i bps slippage",
		async (slippageBps) => {
			const quote = vi.fn(client.quote);
			const provider = new FyndProvider({
				client: { ...client, quote },
				slippageBps,
				chainId: 56,
				trampoline: "0x0000000000000000000000000000000000000005",
				settlement: "0x0000000000000000000000000000000000000004",
				wrappedNative,
				now: () => 105,
			});
			const route = await provider.quote({
				uid: "0x01",
				chainId: 56,
				sellToken: "0x0000000000000000000000000000000000000001",
				buyToken: "0x0000000000000000000000000000000000000002",
				remainingSell: 100n,
				scaledLimitBuy: 100n,
			});
			expect(quote).toHaveBeenCalledWith(
				expect.objectContaining({
					options: {
						timeoutMs: 5000,
						encodingOptions: { slippage: slippageBps / 10_000, transferType: "transfer_from" },
					},
				}),
			);
			expect(route).toMatchObject({ quoteBuyAmount: 110n, minBuyAmount: 110n });
			expect(route?.interactions).toHaveLength(2);
			expect(route?.interactions[0]?.target).toBe("0x0000000000000000000000000000000000000001");
			expect(route?.interactions[0]?.callData).toBe(
				"0x095ea7b300000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000064",
			);
		},
	);

	it("caches validated sidecar info across readiness checks and quotes", async () => {
		let infoCalls = 0;
		const provider = new FyndProvider({
			client: {
				...client,
				info: async () => {
					infoCalls += 1;
					return client.info();
				},
			},
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			wrappedNative,
		});
		await provider.ready();
		await provider.ready();
		await provider.quote({
			uid: "0x01",
			chainId: 56,
			sellToken: "0x0000000000000000000000000000000000000001",
			buyToken: "0x0000000000000000000000000000000000000002",
			remainingSell: 100n,
			scaledLimitBuy: 100n,
		});
		expect(infoCalls).toBe(1);
	});

	it("skips native-sell, same-token, and zero-size orders without calling Fynd", async () => {
		let calls = 0;
		const provider = new FyndProvider({
			client: {
				...client,
				quote: async () => {
					calls += 1;
					return client.quote();
				},
			},
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			wrappedNative,
		});
		for (const [sellToken, buyToken, remainingSell] of [
			[BUY_ETH_ADDRESS, "0x0000000000000000000000000000000000000002", 100n],
			[
				"0x0000000000000000000000000000000000000001",
				"0x0000000000000000000000000000000000000001",
				100n,
			],
			[
				"0x0000000000000000000000000000000000000001",
				"0x0000000000000000000000000000000000000002",
				0n,
			],
		] as const) {
			await expect(
				provider.quote({
					uid: "0x01",
					chainId: 56,
					sellToken,
					buyToken,
					remainingSell,
					scaledLimitBuy: 1n,
				}),
			).resolves.toBeNull();
		}
		expect(calls).toBe(0);
	});

	it("substitutes wrapped native for native buy orders and quotes successfully", async () => {
		const quote = vi.fn(async () => ({
			...(await client.quote()),
			tokenOut: wrappedNative,
		}));
		const provider = new FyndProvider({
			client: { ...client, quote },
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			wrappedNative,
			now: () => 105,
		});
		const route = await provider.quote({
			uid: "0x01",
			chainId: 56,
			sellToken: "0x0000000000000000000000000000000000000001",
			buyToken: BUY_ETH_ADDRESS,
			remainingSell: 100n,
			scaledLimitBuy: 100n,
		});
		expect(quote).toHaveBeenCalledWith(
			expect.objectContaining({
				order: expect.objectContaining({ tokenOut: wrappedNative }),
			}),
		);
		expect(route).toMatchObject({ quoteBuyAmount: 110n, minBuyAmount: 110n });
	});

	it("rejects stale, unsafe, and under-limit successful responses", async () => {
		const badQuote = {
			...client.quote,
		};
		const response = await client.quote();
		const variants = [
			{ ...response, block: { ...response.block, timestamp: 94 } },
			{ ...response, transaction: { ...response.transaction, value: 1n } },
			{ ...response, feeBreakdown: { ...response.feeBreakdown, minAmountReceived: 99n } },
			{ ...response, status: "not_ready" as const },
		];
		for (const quote of variants) {
			const provider = new FyndProvider({
				client: { ...client, quote: async () => quote },
				chainId: 56,
				trampoline: "0x0000000000000000000000000000000000000005",
				settlement: "0x0000000000000000000000000000000000000004",
				wrappedNative,
				now: () => 105,
			});
			await expect(
				provider.quote({
					uid: "0x01",
					chainId: 56,
					sellToken: "0x0000000000000000000000000000000000000001",
					buyToken: "0x0000000000000000000000000000000000000002",
					remainingSell: 100n,
					scaledLimitBuy: 100n,
				}),
			).resolves.toBeNull();
		}
		expect(badQuote).toBeDefined();
	});

	it("fails fast when the sidecar reports the wrong chain or no router", async () => {
		const provider = new FyndProvider({
			client: {
				...client,
				info: async () => ({ chainId: 1, routerAddress: null, permit2Address: router }),
			},
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			wrappedNative,
		});
		await expect(provider.initialize()).rejects.toBeInstanceOf(FyndConfigurationError);
	});
});

describe("Fynd correlated slippage", () => {
	const usdt = "0x55d398326f99059ff775485246999027b3197955" as const;
	const usdc = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" as const;
	const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as const;
	const candidate: CandidateOrder = {
		uid: "0x01",
		chainId: 56,
		sellToken: usdt,
		buyToken: usdc,
		remainingSell: 100n,
		scaledLimitBuy: 100n,
	};

	it.each([undefined, 0, 7])(
		"encodes %s correlated bps independently of ordinary quotes",
		async (correlatedSlippageBps) => {
			// Return each request's output asset so both routes pass token validation.
			const fyndQuote = vi.fn(async (request: Parameters<FyndClient["quote"]>[0]) => ({
				...(await client.quote()),
				tokenOut: request.order.tokenOut,
			}));
			const provider = new FyndProvider({
				client: { ...client, quote: fyndQuote },
				chainId: 56,
				trampoline: "0x0000000000000000000000000000000000000005",
				settlement: "0x0000000000000000000000000000000000000004",
				wrappedNative: wbnb,
				slippageBps: 80,
				correlatedSlippageBps,
				now: () => 105,
			});
			const routes = await Promise.all([
				provider.quote(candidate),
				provider.quote({ ...candidate, uid: "0x02", buyToken: wbnb }),
			]);
			expect(
				fyndQuote.mock.calls.map(([request]) => request.options?.encodingOptions?.slippage),
			).toEqual([(correlatedSlippageBps ?? 5) / 10_000, 0.008]);
			for (const route of routes)
				expect(route).toMatchObject({ quoteBuyAmount: 110n, minBuyAmount: 110n });
		},
	);

	it("selects correlated slippage on original native-buy addresses before wrapping", async () => {
		const quote = vi.fn(async () => ({ ...(await client.quote()), tokenOut: wrappedNative }));
		const provider = new FyndProvider({
			client: { ...client, quote },
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			wrappedNative,
			now: () => 105,
		});
		expect(
			await provider.quote({
				...candidate,
				sellToken: "0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b",
				buyToken: BUY_ETH_ADDRESS,
			}),
		).toMatchObject({ minBuyAmount: 110n, quoteBuyAmount: 110n });
		expect(quote).toHaveBeenCalledWith(
			expect.objectContaining({
				order: expect.objectContaining({ tokenOut: wrappedNative }),
				options: {
					timeoutMs: 5000,
					encodingOptions: { slippage: 0.0005, transferType: "transfer_from" },
				},
			}),
		);
	});
});
