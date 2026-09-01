import type { Address, Hex } from "viem";

export interface OrderbookOrder {
	uid: Hex;
	sellToken: Address;
	buyToken: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	kind: "sell" | "buy";
	fullSellAmount: bigint;
	fullBuyAmount: bigint;
	/** Limit-price heuristic in native-token units, for quote prioritization. */
	estimatedNativeSurplus: bigint;
}

interface AuctionOrderDto {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	fullSellAmount?: string;
	fullBuyAmount?: string;
	kind: string;
	sellTokenBalance: string;
	buyTokenBalance: string;
}

interface AuctionDto {
	orders: AuctionOrderDto[];
	tokens?: Record<string, { referencePrice?: string | null }>;
}

const NATIVE_PRICE_SCALE = 10n ** 18n;

function nativeValue(amount: bigint, referencePrice: string | null | undefined): bigint {
	return referencePrice ? (amount * BigInt(referencePrice)) / NATIVE_PRICE_SCALE : 0n;
}

/** Reusable CoW auction polling client, normalized at the wire boundary. */
export class OrderbookClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async solvableOrders(): Promise<OrderbookOrder[]> {
		const response = await fetch(`${this.baseUrl}/api/v1/auction`);
		if (!response.ok) throw new Error(`orderbook ${response.status}: ${await response.text()}`);
		const auction = (await response.json()) as AuctionDto;
		return auction.orders
			.filter((order) => order.sellTokenBalance === "erc20" && order.buyTokenBalance === "erc20")
			.map((order) => ({
				uid: order.uid as Hex,
				sellToken: order.sellToken as Address,
				buyToken: order.buyToken as Address,
				sellAmount: BigInt(order.sellAmount),
				buyAmount: BigInt(order.buyAmount),
				fullSellAmount: BigInt(order.fullSellAmount ?? order.sellAmount),
				fullBuyAmount: BigInt(order.fullBuyAmount ?? order.buyAmount),
				estimatedNativeSurplus:
					nativeValue(BigInt(order.buyAmount), auction.tokens?.[order.buyToken]?.referencePrice) -
					nativeValue(BigInt(order.sellAmount), auction.tokens?.[order.sellToken]?.referencePrice),
				kind: order.kind as "sell" | "buy",
			}));
	}
}
