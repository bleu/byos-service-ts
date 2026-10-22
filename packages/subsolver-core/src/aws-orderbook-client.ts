import type { Address, PublicClient } from "viem";
import { parseAbiItem } from "viem";
import { type AuctionDto, type OrderbookOrder, toOrderbookOrders } from "./orderbook-client.js";

const SETTLEMENT_EVENT = parseAbiItem("event Settlement(address indexed solver)");

const FRESH_ORDER_WINDOW_SECS = 4000;
// How far back to search for the last Settlement event. BSC produces ~3s blocks,
// so 5000 blocks ≈ 4 hours. Increase if your RPC provider supports wider ranges.
const SETTLEMENT_LOOKBACK_BLOCKS = 5_000n;

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

/** Discovers solvable orders from S3-hosted autopilot JSON files.
 *  Gets the latest auction ID from the calldata of the most recent on-chain settlement. */
export class AwsOrderbookClient {
	private readonly awsUrl: string;
	private readonly publicClient: PublicClient;
	private readonly settlementAddress: Address;

	constructor(awsUrl: string, publicClient: PublicClient, settlementAddress: Address) {
		this.awsUrl = awsUrl.replace(/\/+$/, "");
		this.publicClient = publicClient;
		this.settlementAddress = settlementAddress;
	}

	async solvableOrders(): Promise<OrderbookOrder[]> {
		const latestId = await this.getLatestAuctionId();

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

	/** Reads the last 8 bytes of the most recent on-chain settle() calldata as big-endian int64. */
	private async getLatestAuctionId(): Promise<number> {
		const latestBlock = await this.publicClient.getBlockNumber();
		const fromBlock =
			latestBlock > SETTLEMENT_LOOKBACK_BLOCKS ? latestBlock - SETTLEMENT_LOOKBACK_BLOCKS : 0n;

		const logs = await this.publicClient.getLogs({
			address: this.settlementAddress,
			event: SETTLEMENT_EVENT,
			fromBlock,
			toBlock: "latest",
		});

		if (logs.length === 0) {
			throw new Error(
				`No Settlement events found in the last ${SETTLEMENT_LOOKBACK_BLOCKS} blocks`,
			);
		}

		const latestLog = logs[logs.length - 1] as (typeof logs)[0];
		const txHash = latestLog.transactionHash;
		if (!txHash) throw new Error("Settlement log missing transaction hash");
		const tx = await this.publicClient.getTransaction({ hash: txHash });

		// The driver appends the auction ID as 8 big-endian bytes after the standard ABI-encoded
		// settle() parameters (see cowprotocol/services: encoding.rs, settle_calldata.extend(...))
		const calldata = tx.input;
		if (calldata.length < 18) {
			// 0x + at least 16 hex chars (8 bytes)
			throw new Error("Settlement calldata too short to contain an auction ID");
		}
		return Number(BigInt(`0x${calldata.slice(-16)}`));
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
