import type { Address, Hex } from "viem";
import { parseEther } from "viem";
import type { OrderbookOrder } from "./orderbook-client.js";

const NATIVE_PRICE_SCALE = parseEther("1");

interface MinimalLogger {
	info(obj: object, msg: string): void;
	warn(obj: object, msg: string): void;
	warn(msg: string): void;
}

function nativeValue(amount: bigint, referencePrice: string | null | undefined): bigint {
	return referencePrice ? (amount * BigInt(referencePrice)) / NATIVE_PRICE_SCALE : 0n;
}

function isOrdersPayload(body: unknown): body is {
	orders: {
		uid: string;
		sellToken: string;
		buyToken: string;
		sellAmount: string;
		buyAmount: string;
		fullSellAmount?: string;
		fullBuyAmount?: string;
		kind: string;
		sellTokenSource: string;
		buyTokenDestination: string;
	}[];
	tokens?: Record<string, { referencePrice?: string | null }>;
} {
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
	return Array.isArray(b.orders);
}

/** Receives CoW auction payloads via a push interface and exposes them as solvableOrders(). */
export class SolveOrderbookClient {
	private latestOrders: OrderbookOrder[] = [];
	private readonly logger: MinimalLogger | undefined;

	constructor(logger?: MinimalLogger) {
		this.logger = logger;
	}

	/**
	 * Called with the raw auction body forwarded by BYOS.
	 * Parses orders and stores them for the next solvableOrders() call.
	 */
	receive(body: unknown): void {
		if (!isOrdersPayload(body)) {
			this.logger?.warn("solve payload missing orders array, ignoring");
			return;
		}

		const orders: OrderbookOrder[] = [];
		for (const o of body.orders) {
			if (o.sellTokenSource !== "erc20" || o.buyTokenDestination !== "erc20") continue;
			try {
				const nativeBuyValue = nativeValue(
					BigInt(o.buyAmount),
					body.tokens?.[o.buyToken]?.referencePrice,
				);
				const nativeSellValue = nativeValue(
					BigInt(o.sellAmount),
					body.tokens?.[o.sellToken]?.referencePrice,
				);
				orders.push({
					uid: o.uid as Hex,
					sellToken: o.sellToken as Address,
					buyToken: o.buyToken as Address,
					sellAmount: BigInt(o.sellAmount),
					buyAmount: BigInt(o.buyAmount),
					fullSellAmount: BigInt(o.fullSellAmount ?? o.sellAmount),
					fullBuyAmount: BigInt(o.fullBuyAmount ?? o.buyAmount),
					estimatedNativeSurplus: nativeBuyValue - nativeSellValue,
					nativeBuyValue,
					nativeSellValue,
					kind: o.kind as "sell" | "buy",
					// createdAt intentionally absent: driver auction payload does not include it
				});
			} catch {
				this.logger?.warn({ uid: o.uid }, "failed to parse order from solve payload, skipping");
			}
		}

		this.latestOrders = orders;
		this.logger?.info({ orderCount: orders.length }, "solve payload received");
	}

	async solvableOrders(): Promise<OrderbookOrder[]> {
		return this.latestOrders;
	}
}
