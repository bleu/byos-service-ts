import { BUY_ETH_ADDRESS } from "@byos/common";
import {
	encodingOptions,
	type FyndClient,
	type InstanceInfo,
	type Quote,
} from "@kayibal/fynd-client";
import type { CandidateOrder, ProviderRoute, RouteProvider } from "./provider.js";

type Address = `0x${string}`;
type Hex = `0x${string}`;

export interface FyndProviderConfig {
	client: Pick<FyndClient, "quote" | "health" | "info">;
	chainId: number;
	trampoline: Address;
	settlement: Address;
	slippageBps?: number;
	maxQuoteAgeSeconds?: number;
	now?: () => number;
}

/** BSC-only Fynd adapter. It quotes; the shared pipeline signs and submits. */
export class FyndProvider implements RouteProvider {
	readonly name = "fynd";
	private readonly slippageBps: number;
	private readonly maxQuoteAgeSeconds: number;
	private readonly now: () => number;

	constructor(private readonly config: FyndProviderConfig) {
		this.slippageBps = config.slippageBps ?? 50;
		this.maxQuoteAgeSeconds = config.maxQuoteAgeSeconds ?? 10;
		this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
	}

	/**
	 * Performs the static readiness check once at process startup. A Fynd
	 * provider is deliberately BSC-only, so a mismatched sidecar is a
	 * configuration error rather than a condition to silently quote through.
	 */
	async initialize(): Promise<void> {
		if (this.config.chainId !== 56) {
			throw new Error(`Fynd is only supported on BSC (chain 56), got ${this.config.chainId}`);
		}
		const info = await this.config.client.info();
		this.assertBscRouter(info);
	}

	async ready(): Promise<boolean> {
		await this.initialize();
		const health = await this.config.client.health();
		return health.healthy;
	}

	async quote(order: CandidateOrder): Promise<ProviderRoute | null> {
		if (
			order.chainId !== 56 ||
			order.remainingSell <= 0n ||
			order.sellToken.toLowerCase() === order.buyToken.toLowerCase() ||
			order.sellToken.toLowerCase() === BUY_ETH_ADDRESS.toLowerCase() ||
			order.buyToken.toLowerCase() === BUY_ETH_ADDRESS.toLowerCase()
		)
			return null;
		const info = await this.config.client.info();
		this.assertBscRouter(info);
		const quote = await this.config.client.quote({
			order: {
				tokenIn: order.sellToken,
				tokenOut: order.buyToken,
				amount: order.remainingSell,
				side: "sell",
				sender: this.config.trampoline,
				receiver: this.config.settlement,
			},
			options: { timeoutMs: 5000, encodingOptions: encodingOptions(this.slippageBps / 10_000) },
		});
		return this.toRoute(order, info.routerAddress, quote);
	}

	private assertBscRouter(
		info: InstanceInfo,
	): asserts info is InstanceInfo & { routerAddress: Address } {
		if (info.chainId !== this.config.chainId) {
			throw new Error(
				`Fynd sidecar chain ${info.chainId} does not match configured chain ${this.config.chainId}`,
			);
		}
		if (info.routerAddress == null) throw new Error("Fynd sidecar did not report a router address");
	}

	private toRoute(order: CandidateOrder, router: Address, quote: Quote): ProviderRoute | null {
		if (quote.status !== "success" || quote.amountIn !== order.remainingSell) return null;
		if (!quote.route || !quote.transaction || !quote.feeBreakdown) return null;
		if (
			quote.transaction.to.toLowerCase() !== router.toLowerCase() ||
			quote.transaction.value !== 0n
		)
			return null;
		if (quote.feeBreakdown.minAmountReceived < order.scaledLimitBuy) return null;
		if (quote.receiver.toLowerCase() !== this.config.settlement.toLowerCase()) return null;
		if (quote.tokenOut.toLowerCase() !== order.buyToken.toLowerCase()) return null;
		if (this.now() - quote.block.timestamp > this.maxQuoteAgeSeconds) return null;
		return {
			quoteBuyAmount: quote.amountOut,
			minBuyAmount: quote.feeBreakdown.minAmountReceived,
			interactions: [
				{
					target: order.sellToken,
					value: 0n,
					callData:
						`0x095ea7b3${router.slice(2).padStart(64, "0")}${order.remainingSell.toString(16).padStart(64, "0")}` as Hex,
				},
				{ target: quote.transaction.to, value: 0n, callData: quote.transaction.data },
			],
		};
	}
}
