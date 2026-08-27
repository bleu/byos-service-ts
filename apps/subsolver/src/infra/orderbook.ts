import type { Address, Hex } from "viem";
import type { Order } from "../domain/proposal.js";

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
}

export class OrderbookClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	/** Fetches solvable orders from the CoW orderbook, filtered to erc20 balances only. */
	async solvableOrders(): Promise<Order[]> {
		const response = await fetch(`${this.baseUrl}/api/v1/auction`);
		if (!response.ok) {
			throw new Error(`orderbook ${response.status}: ${await response.text()}`);
		}

		const auction = (await response.json()) as AuctionDto;

		return auction.orders
			.filter((o) => o.sellTokenBalance === "erc20" && o.buyTokenBalance === "erc20")
			.map((o) => ({
				uid: o.uid as Hex,
				sellToken: o.sellToken as Address,
				buyToken: o.buyToken as Address,
				sellAmount: BigInt(o.sellAmount),
				buyAmount: BigInt(o.buyAmount),
				fullSellAmount: BigInt(o.fullSellAmount ?? o.sellAmount),
				fullBuyAmount: BigInt(o.fullBuyAmount ?? o.buyAmount),
				kind: o.kind as "sell" | "buy",
			}));
	}
}
