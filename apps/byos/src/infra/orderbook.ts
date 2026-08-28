import type { SettlementInteraction } from "@byos/common";
import { type CowOrder, OrderKind, SigningScheme } from "@byos/common";
import type { SupportedChainId } from "@cowprotocol/cow-sdk";
import { OrderBookApi, OrderBookApiError } from "@cowprotocol/cow-sdk";
import type { Address, Hex } from "viem";
import type { OrderRecord } from "../domain/order.js";

// --- Error ---

export type OrderbookError = { kind: "notFound" } | { kind: "transient"; message: string };

// --- Interface ---

export interface FetchOrder {
	order(uid: string): Promise<OrderRecord>;
	nativePrice(token: Address): Promise<bigint>;
}

// --- Error mapping ---

/**
 * Classify an error thrown by `OrderBookApi` into an `OrderbookError`.
 *
 * - 404 → terminal (order/token not found)
 * - 429 → transient (rate-limited; SDK exhausts its retries before surfacing)
 * - 5xx → transient (server error)
 * - other 4xx → transient (unexpected; defer rather than permanently reject)
 * - network/connection failure → transient
 */
export function classifyOrderbookError(err: unknown, context: string): OrderbookError {
	if (err instanceof OrderBookApiError) {
		const status = err.response.status;
		if (status === 404) {
			return { kind: "notFound" };
		}
		// All non-404 HTTP errors are transient: 429 (rate-limited), 5xx (server
		// error), and unexpected 4xx all warrant a retry rather than a permanent
		// rejection of an otherwise-valid proposal.
		return { kind: "transient", message: `${context} ${status}` };
	}

	// Network-level error (connection refused, timeout, DNS failure, etc.)
	return { kind: "transient", message: `${context} unreachable: ${err}` };
}

// --- DTO conversion ---

const ETHER = 10n ** 18n;
const CACHE_CAPACITY = 10_000;

// Unknown enum values throw transient rather than coercing: the Rust DTO's
// closed serde enums fail deserialization, so the validator defers instead of
// mis-classifying the order.
function mapKind(kind: string): OrderKind {
	if (kind === "sell") return OrderKind.SELL;
	if (kind === "buy") return OrderKind.BUY;
	throw { kind: "transient", message: `unknown order kind ${kind}` } satisfies OrderbookError;
}

function mapSigningScheme(scheme: string): SigningScheme {
	switch (scheme) {
		case "eip712":
			return SigningScheme.Eip712;
		case "ethsign":
			return SigningScheme.EthSign;
		case "eip1271":
			return SigningScheme.Eip1271;
		case "presign":
			return SigningScheme.PreSign;
		default:
			throw {
				kind: "transient",
				message: `unknown signing scheme ${scheme}`,
			} satisfies OrderbookError;
	}
}

function sdkOrderToRecord(sdkOrder: Awaited<ReturnType<OrderBookApi["getOrder"]>>): OrderRecord {
	const erc20Balances =
		sdkOrder.sellTokenBalance === "erc20" && sdkOrder.buyTokenBalance === "erc20";

	const order: CowOrder = {
		sellToken: sdkOrder.sellToken as Address,
		buyToken: sdkOrder.buyToken as Address,
		receiver: (sdkOrder.receiver ?? "0x0000000000000000000000000000000000000000") as Address,
		sellAmount: BigInt(sdkOrder.sellAmount),
		buyAmount: BigInt(sdkOrder.buyAmount),
		validTo: sdkOrder.validTo,
		appData: sdkOrder.appData as Hex,
		feeAmount: BigInt(sdkOrder.feeAmount),
		kind: mapKind(sdkOrder.kind),
		partiallyFillable: sdkOrder.partiallyFillable,
		signingScheme: mapSigningScheme(sdkOrder.signingScheme),
		signature: sdkOrder.signature as Hex,
	};

	const preInteractions = (sdkOrder.interactions?.pre ?? []).map(
		(i): SettlementInteraction => ({
			target: i.target as Address,
			value: BigInt(i.value),
			callData: i.callData as Hex,
		}),
	);

	const postInteractions = (sdkOrder.interactions?.post ?? []).map(
		(i): SettlementInteraction => ({
			target: i.target as Address,
			value: BigInt(i.value),
			callData: i.callData as Hex,
		}),
	);

	return { order, preInteractions, postInteractions, erc20Balances };
}

// --- Client ---

/**
 * Wraps `OrderBookApi` from the cow-sdk with:
 * - Our `OrderbookError` union (retryable/terminal classification)
 * - An order cache bounded by capacity (COW-1198: prevents memory growth when
 *   the same order is fetched repeatedly across validation ticks)
 */
export class OrderbookClient implements FetchOrder {
	private cache = new Map<string, OrderRecord>();
	private readonly api: OrderBookApi;

	constructor(
		chainId: SupportedChainId,
		baseUrlOverride?: string,
		private readonly cacheCapacity: number = CACHE_CAPACITY,
	) {
		if (baseUrlOverride) {
			// Build a per-chain map: only our chain's slot matters, but the type
			// requires all chains. Cast is safe — sdk only reads baseUrls[chainId].
			const allUrls = { [chainId]: baseUrlOverride } as Record<SupportedChainId, string>;
			this.api = new OrderBookApi({ chainId, baseUrls: allUrls });
		} else {
			this.api = new OrderBookApi({ chainId });
		}
	}

	private remember(uid: string, record: OrderRecord): void {
		const key = uid.toLowerCase();
		if (this.cache.size >= this.cacheCapacity && !this.cache.has(key)) {
			this.cache.clear();
		}
		this.cache.set(key, record);
	}

	async order(uid: string): Promise<OrderRecord> {
		const key = uid.toLowerCase();
		const cached = this.cache.get(key);
		if (cached) return cached;

		let sdkOrder: Awaited<ReturnType<OrderBookApi["getOrder"]>>;
		try {
			sdkOrder = await this.api.getOrder(uid);
		} catch (err) {
			throw classifyOrderbookError(err, "orderbook");
		}

		// sdkOrderToRecord may throw OrderbookError (mapKind / mapSigningScheme)
		const record = sdkOrderToRecord(sdkOrder);

		this.remember(uid, record);
		return record;
	}

	async nativePrice(token: Address): Promise<bigint> {
		let result: { price?: number };
		try {
			result = await this.api.getNativePrice(token);
		} catch (err) {
			throw classifyOrderbookError(err, "orderbook price");
		}

		const price = result.price;
		if (price === undefined || !Number.isFinite(price) || price < 0) {
			throw {
				kind: "transient",
				message: `unusable native price ${price}`,
			} satisfies OrderbookError;
		}

		// Convert to reference semantics: multiply by 1e18
		return BigInt(Math.floor(price * Number(ETHER)));
	}
}
