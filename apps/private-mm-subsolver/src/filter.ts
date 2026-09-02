import type { OrderbookOrder } from "@byos/subsolver-core";
import type { Address } from "viem";

export interface FilterConfig {
	usdcAddress: Address;
	usdtAddress: Address;
	/** Static trampoline balances keyed by lowercased token address */
	trampolineBalance: Map<string, bigint>;
	/** Lowercased orderUids already tracked in the local proposals cache */
	trackedUids: Set<string>;
}

/**
 * Returns the subset of orderbook orders that this MM subsolver should propose on.
 *
 * Criteria:
 * - Fill-or-kill sell orders only (no buy orders, no partial fills)
 * - Token pair must be exactly USDC/USDT (either direction)
 * - sellAmount must not exceed the trampoline's balance of the buyToken (1:1 delivery assumption)
 * - Order must not already have a tracked proposal
 */
export function filterCandidates(orders: OrderbookOrder[], config: FilterConfig): OrderbookOrder[] {
	const usdc = config.usdcAddress.toLowerCase();
	const usdt = config.usdtAddress.toLowerCase();

	return orders.filter((order) => {
		if (order.kind !== "sell") return false;
		if (order.sellAmount !== order.fullSellAmount) return false;

		const sell = order.sellToken.toLowerCase();
		const buy = order.buyToken.toLowerCase();
		const isUsdcUsdtPair = (sell === usdc && buy === usdt) || (sell === usdt && buy === usdc);
		if (!isUsdcUsdtPair) return false;

		const balance = config.trampolineBalance.get(buy) ?? 0n;
		if (order.sellAmount > balance) return false;

		if (config.trackedUids.has(order.uid.toLowerCase())) return false;

		return true;
	});
}
