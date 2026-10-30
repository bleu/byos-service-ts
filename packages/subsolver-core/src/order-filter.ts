import type { OrderbookOrder } from "./orderbook-client.js";

const SCALE = BigInt(1e18);

export interface OrderFilterOptions {
	closeToExecutionTopN: number;
}

/** Select sell orders that are new since the previous auction or rank in the
 * top-N by relative spread. The first snapshot establishes the baseline.
 * Remember every input UID, including orders excluded from selection. */
export class OrderFilter {
	private previousUids: Set<string> | undefined;

	constructor(private readonly opts: OrderFilterOptions) {}

	filter(allOrders: OrderbookOrder[]): OrderbookOrder[] {
		const previousUids = this.previousUids;
		this.previousUids = new Set(allOrders.map((order) => order.uid.toLowerCase()));
		const orders = allOrders.filter((order) => order.kind === "sell");
		const newUids = new Set(
			previousUids === undefined
				? []
				: orders
						.filter((order) => !previousUids.has(order.uid.toLowerCase()))
						.map((order) => order.uid.toLowerCase()),
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

		return orders.filter(
			(o) => newUids.has(o.uid.toLowerCase()) || closeToExecutionUids.has(o.uid),
		);
	}
}
