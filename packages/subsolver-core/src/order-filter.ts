import type { OrderbookOrder } from "./orderbook-client.js";

const SCALE = BigInt(1e18);

export interface OrderFilterOptions {
	freshOrderWindowSecs: number;
	closeToExecutionTopN: number;
}

/** Filters a list of orders the same way the legacy AwsOrderbookClient did:
 *  keeps orders that are either (a) recently created or (b) in the top-N by
 *  relative spread. Orders without createdAt skip the freshness check and only
 *  pass through the close-to-execution set. */
export class OrderFilter {
	constructor(private readonly opts: OrderFilterOptions) {}

	filter(orders: OrderbookOrder[]): OrderbookOrder[] {
		if (orders.length === 0) return orders;

		const nowSecs = Math.floor(Date.now() / 1000);

		const freshUids = new Set(
			orders
				.filter(
					(o) =>
						o.createdAt !== undefined && o.createdAt >= nowSecs - this.opts.freshOrderWindowSecs,
				)
				.map((o) => o.uid),
		);

		const closeToExecutionUids = new Set(
			[...orders]
				.map((o) => ({
					uid: o.uid,
					relativeSpread:
						o.nativeSellValue > 0n ? (o.nativeBuyValue * SCALE) / o.nativeSellValue : 0n,
				}))
				.sort((a, b) =>
					a.relativeSpread > b.relativeSpread ? -1 : a.relativeSpread < b.relativeSpread ? 1 : 0,
				)
				.slice(0, this.opts.closeToExecutionTopN)
				.map((x) => x.uid),
		);

		return orders.filter((o) => freshUids.has(o.uid) || closeToExecutionUids.has(o.uid));
	}
}
