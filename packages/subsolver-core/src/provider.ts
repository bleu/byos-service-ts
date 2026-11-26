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
	quote(order: CandidateOrder): Promise<ProviderRoute | null>;
	/** Independently executable alternatives for the same order. */
	quoteMany?(order: CandidateOrder): Promise<ProviderRoute[]>;
}

export interface QuoteResult {
	order: CandidateOrder;
	route: ProviderRoute | null;
	error?: unknown;
}

/**
 * Quotes independent orders with bounded all-settled concurrency and hands each
 * order's results to `onResult` as soon as that order is quoted, so a slow
 * order never holds back the submission of routes that are already ready.
 * Provider failures are deliberately isolated: one bad order cannot suppress
 * an otherwise valid batch.
 */
export async function streamQuotes(
	provider: RouteProvider,
	orders: readonly CandidateOrder[],
	onResult: (result: QuoteResult) => Promise<void>,
	concurrency = 32,
): Promise<void> {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error("quote concurrency must be a positive integer");
	}
	let cursor = 0;
	const worker = async () => {
		while (true) {
			const order = orders[cursor++];
			if (!order) return;
			let results: QuoteResult[];
			try {
				const routes =
					provider.quoteMany && (order.nativeSellValue ?? 0n) > 10n ** 18n
						? await provider.quoteMany(order)
						: [await provider.quote(order)];
				results =
					routes.length > 0 ? routes.map((route) => ({ order, route })) : [{ order, route: null }];
			} catch (error) {
				results = [{ order, route: null, error }];
			}
			for (const result of results) await onResult(result);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, orders.length) }, worker));
}

/** Collects every result, in input order, for consumers that need the full batch. */
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
