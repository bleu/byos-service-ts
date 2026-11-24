import { type AuctionWork, canQuote, untilAborted } from "./auction-work.js";

type Address = `0x${string}`;
type ContractInteraction = { target: Address; value: bigint; callData: `0x${string}` };

/** An order candidate normalized by the shared polling pipeline. */
export interface CandidateOrder {
	uid: string;
	chainId: number;
	sellToken: Address;
	buyToken: Address;
	remainingSell: bigint;
	scaledLimitBuy: bigint;
	/** Remaining sell amount valued in native wei using auction reference prices. */
	nativeSellValue?: bigint;
}

/** A route a provider has quoted but not yet signed or submitted. */
export interface ProviderRoute {
	quoteBuyAmount: bigint;
	minBuyAmount: bigint;
	interactions: ContractInteraction[];
}

/**
 * Provider boundary for the reusable sub-solver pipeline. Implementations may
 * fail an individual order without interrupting the rest of a polling batch.
 */
export interface RouteProvider {
	readonly name: string;
	quote(order: CandidateOrder, work?: AuctionWork): Promise<ProviderRoute | null>;
	/** Independently executable alternatives for the same order. */
	quoteMany?(order: CandidateOrder, work?: AuctionWork): Promise<ProviderRoute[]>;
}

export interface QuoteResult {
	order: CandidateOrder;
	route: ProviderRoute | null;
	error?: unknown;
	quoteElapsedMs?: number;
}

/**
 * Quotes independent orders with bounded all-settled concurrency. Provider
 * failures are deliberately isolated: one bad order cannot suppress an
 * otherwise valid batch.
 */
export async function streamQuotes(
	provider: RouteProvider,
	orders: readonly CandidateOrder[],
	onResult: (result: QuoteResult) => Promise<void>,
	concurrency = 32,
	work?: AuctionWork,
): Promise<void> {
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error("quote concurrency must be a positive integer");
	let cursor = 0;
	const worker = async () => {
		while (canQuote(work)) {
			const order = orders[cursor++];
			if (!order) return;
			const startedAt = Date.now();
			let results: QuoteResult[];
			try {
				const quoting =
					provider.quoteMany && (order.nativeSellValue ?? 0n) > 10n ** 18n
						? provider.quoteMany(order, work)
						: provider.quote(order, work).then((route) => (route ? [route] : []));
				const routes = await (work ? untilAborted(quoting, work.signal) : quoting);
				results = routes.length
					? routes.map((route) => ({ order, route, quoteElapsedMs: Date.now() - startedAt }))
					: [{ order, route: null }];
			} catch (error) {
				if (work?.signal.aborted) return;
				results = [{ order, route: null, error }];
			}
			await Promise.all(results.map(onResult));
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, orders.length) }, worker));
}

/** Compatibility collector for consumers that need the complete result set. */
export async function quoteBatch(
	provider: RouteProvider,
	orders: readonly CandidateOrder[],
	concurrency = 32,
): Promise<QuoteResult[]> {
	const results = new Map<CandidateOrder, QuoteResult[]>();
	await streamQuotes(
		provider,
		orders,
		async (result) => {
			const group = results.get(result.order) ?? [];
			group.push(result);
			results.set(result.order, group);
		},
		concurrency,
	);
	return orders.flatMap((order) => results.get(order) ?? []);
}
