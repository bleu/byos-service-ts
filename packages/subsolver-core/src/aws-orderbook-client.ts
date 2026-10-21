import { type AuctionDto, type OrderbookOrder, toOrderbookOrders } from "./orderbook-client.js";

const FRESH_ORDER_WINDOW_SECS = 4000;

interface AutopilotOrderDto {
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
	created: number;
	validTo: number;
}

interface AutopilotDto {
	orders: AutopilotOrderDto[];
	prices?: Record<string, string>;
}

interface SolverCompetitionLatest {
	auctionId: number;
}

/** Discovers solvable orders from S3-hosted autopilot JSON files. */
export class AwsOrderbookClient {
	private readonly awsUrl: string;
	private readonly orderbookUrl: string;

	constructor(awsUrl: string, orderbookUrl: string) {
		this.awsUrl = awsUrl.replace(/\/+$/, "");
		this.orderbookUrl = orderbookUrl.replace(/\/+$/, "");
	}

	async solvableOrders(): Promise<OrderbookOrder[]> {
		const response = await fetch(`${this.orderbookUrl}/api/v2/solver_competition/latest`);
		if (!response.ok) {
			throw new Error(`competition API ${response.status}: ${await response.text()}`);
		}
		const { auctionId: latestId } = (await response.json()) as SolverCompetitionLatest;

		const results = await Promise.all(
			[latestId + 1, latestId + 2, latestId + 3, latestId + 4, latestId + 5, latestId + 6].map(
				(id) => this.fetchAuction(id).then((auction) => (auction ? { id, auction } : null)),
			),
		);

		const best = results
			.filter((r): r is { id: number; auction: AutopilotDto } => r !== null)
			.at(-1);

		if (!best) return [];

		const nowSecs = Math.floor(Date.now() / 1000);
		const freshOrders = best.auction.orders.filter(
			(o) =>
				o.validTo <= nowSecs + FRESH_ORDER_WINDOW_SECS &&
				o.created >= nowSecs - FRESH_ORDER_WINDOW_SECS,
		);

		const auctionDto: AuctionDto = {
			orders: freshOrders,
			tokens: best.auction.prices
				? Object.fromEntries(
						Object.entries(best.auction.prices).map(([addr, price]) => [
							addr,
							{ referencePrice: price },
						]),
					)
				: undefined,
		};

		return toOrderbookOrders(auctionDto);
	}

	private async fetchAuction(id: number): Promise<AutopilotDto | null> {
		try {
			const response = await fetch(`${this.awsUrl}/autopilot/${id}.json`);
			if (!response.ok) return null;
			return (await response.json()) as AutopilotDto;
		} catch {
			return null;
		}
	}
}
