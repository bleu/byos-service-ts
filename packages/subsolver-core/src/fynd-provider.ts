import { BUY_ETH_ADDRESS, Erc20Abi } from "@byos/common";
import {
	encodingOptions,
	type FyndClient,
	type InstanceInfo,
	type Quote,
} from "@kayibal/fynd-client";
import { encodeFunctionData } from "viem";
import type { CandidateOrder, ProviderRoute, RouteProvider } from "./provider.js";

type Address = `0x${string}`;

export interface FyndProviderConfig {
	client: Pick<FyndClient, "quote" | "health" | "info">;
	chainId: number;
	trampoline: Address;
	settlement: Address;
	slippageBps?: number;
	maxQuoteAgeSeconds?: number;
	now?: () => number;
}

/** A permanent startup mismatch; retrying the sidecar cannot repair it. */
export class FyndConfigurationError extends Error {}

/** BSC-only Fynd adapter. It quotes; the shared pipeline signs and submits. */
export class FyndProvider implements RouteProvider {
	readonly name = "fynd";
	private readonly slippageBps: number;
	private readonly maxQuoteAgeSeconds: number;
	private readonly now: () => number;
	private info: (InstanceInfo & { routerAddress: Address }) | undefined;

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
			throw new FyndConfigurationError(
				`Fynd is only supported on BSC (chain 56), got ${this.config.chainId}`,
			);
		}
		if (!this.info) this.info = this.checkedInfo(await this.config.client.info());
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
		let info = this.info;
		if (!info) {
			info = this.checkedInfo(await this.config.client.info());
			this.info = info;
		}
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
			throw new FyndConfigurationError(
				`Fynd sidecar chain ${info.chainId} does not match configured chain ${this.config.chainId}`,
			);
		}
		if (info.routerAddress == null) {
			throw new FyndConfigurationError("Fynd sidecar did not report a router address");
		}
	}

	private checkedInfo(info: InstanceInfo): InstanceInfo & { routerAddress: Address } {
		this.assertBscRouter(info);
		return info;
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
					callData: encodeFunctionData({
						abi: Erc20Abi,
						functionName: "approve",
						args: [router, order.remainingSell],
					}),
				},
				{ target: quote.transaction.to, value: 0n, callData: quote.transaction.data },
			],
		};
	}
}
