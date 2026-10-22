import type { Address, PublicClient } from "viem";
import { parseAbiItem } from "viem";
import { type AuctionDto, type OrderbookOrder, toOrderbookOrders } from "./orderbook-client.js";

const FRESH_ORDER_WINDOW_SECS = 4000;
// How far back to search for the last Settlement event. BSC produces ~3s blocks,
// so 1000 blocks ≈ 50 minutes.
const SETTLEMENT_LOOKBACK_BLOCKS = 1_000n;
const POLLING_WINDOW = 6; // C+1 … C+6 in normal polling
const DEFAULT_MAX_DISCOVERY_REQUESTS = 32;
export const RECOVERY_THRESHOLD_MS = 60_000; // exported so tests can reference it
const FETCH_TIMEOUT_MS = 10_000;
const SETTLE_SELECTOR = "0x13d79a0b"; // GPv2Settlement.settle() selector
const SETTLEMENT_EVENT = parseAbiItem("event Settlement(address indexed solver)");

type FetchOutcome =
	| { type: "found"; data: AutopilotDto }
	| { type: "not_found" }
	| { type: "error" };

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

export interface AwsOrderbookClientOptions {
	bootstrapAuctionId?: number; // fallback anchor when no recent on-chain settlement
	maxDiscoveryRequests?: number; // default DEFAULT_MAX_DISCOVERY_REQUESTS
}

/** Discovers solvable orders from S3-hosted autopilot JSON files.
 *  Uses cursor-based polling with exponential + binary search discovery. */
export class AwsOrderbookClient {
	private readonly awsUrl: string;
	private readonly publicClient: PublicClient;
	private readonly settlementAddress: Address;
	private readonly bootstrapAuctionId: number | undefined;
	private readonly maxDiscoveryRequests: number;

	private latestPublishedId: number | undefined;
	private lastPolledAt: number | undefined;

	constructor(
		awsUrl: string,
		publicClient: PublicClient,
		settlementAddress: Address,
		options: AwsOrderbookClientOptions = {},
	) {
		this.awsUrl = awsUrl.replace(/\/+$/, "");
		this.publicClient = publicClient;
		this.settlementAddress = settlementAddress;
		this.bootstrapAuctionId = options.bootstrapAuctionId;
		this.maxDiscoveryRequests = options.maxDiscoveryRequests ?? DEFAULT_MAX_DISCOVERY_REQUESTS;
	}

	async solvableOrders(): Promise<OrderbookOrder[]> {
		const now = Date.now();
		const best = await this.findLatestSnapshot(now);
		this.lastPolledAt = now;

		if (!best) return [];

		const nowSecs = Math.floor(now / 1000);
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

	private async findLatestSnapshot(
		now: number,
	): Promise<{ id: number; auction: AutopilotDto } | null> {
		if (this.latestPublishedId === undefined) {
			return this.bootstrap();
		}

		if (this.lastPolledAt !== undefined && now - this.lastPolledAt > RECOVERY_THRESHOLD_MS) {
			const result = await this.searchForward(this.latestPublishedId, this.maxDiscoveryRequests);
			if (result !== null) {
				this.latestPublishedId = result.id;
			}
			return result;
		}

		return this.pollFromCursor();
	}

	private async bootstrap(): Promise<{ id: number; auction: AutopilotDto } | null> {
		const anchorId = await this.getBootstrapAnchorId();
		if (anchorId === null) return null;

		const result = await this.searchForward(anchorId, this.maxDiscoveryRequests);
		if (result !== null) {
			this.latestPublishedId = result.id;
		}
		return result;
	}

	private async getBootstrapAnchorId(): Promise<number | null> {
		try {
			const id = await this.getAuctionIdFromSettlement();
			if (id !== null) return id;
		} catch {
			// fall through to bootstrapAuctionId
		}
		return this.bootstrapAuctionId ?? null;
	}

	private async pollFromCursor(): Promise<{ id: number; auction: AutopilotDto } | null> {
		// latestPublishedId is always set before pollFromCursor is called
		const cursor = this.latestPublishedId ?? 0;
		const ids = Array.from({ length: POLLING_WINDOW }, (_, i) => cursor + 1 + i);

		const results = await Promise.all(
			ids.map((id) =>
				this.fetchAuction(id).then((outcome): { id: number; auction: AutopilotDto } | null => {
					if (outcome.type === "found") return { id, auction: outcome.data };
					return null;
				}),
			),
		);

		const best = results
			.filter((r): r is { id: number; auction: AutopilotDto } => r !== null)
			.at(-1);
		if (!best) return null;

		const lastSlotPopulated = results[POLLING_WINDOW - 1] !== null;
		if (lastSlotPopulated) {
			const wider = await this.searchForward(best.id, this.maxDiscoveryRequests);
			if (wider !== null) {
				this.latestPublishedId = wider.id;
				return wider;
			}
		}

		this.latestPublishedId = best.id;
		return best;
	}

	private async searchForward(
		anchor: number,
		budget: number,
	): Promise<{ id: number; auction: AutopilotDto } | null> {
		if (budget <= 0) return null;

		const anchorOutcome = await this.fetchAuction(anchor);
		budget--;

		if (anchorOutcome.type !== "found") return null;

		let lowerBound = anchor;
		let bestAuction = anchorOutcome.data;
		let upperBound: number | null = null;

		// Exponential phase
		let offset = 1;
		while (budget > 0 && upperBound === null) {
			const probeId = anchor + offset;
			const outcome = await this.fetchAuction(probeId);
			budget--;

			if (outcome.type === "found") {
				lowerBound = probeId;
				bestAuction = outcome.data;
				offset *= 2;
			} else if (outcome.type === "not_found") {
				upperBound = probeId;
				break;
			} else {
				// error — don't treat as boundary
				return { id: lowerBound, auction: bestAuction };
			}
		}

		// Budget exhausted, no 404 found
		if (upperBound === null) {
			return { id: lowerBound, auction: bestAuction };
		}

		// Binary search phase
		while (upperBound - lowerBound > 1 && budget > 0) {
			const mid = Math.floor((lowerBound + upperBound) / 2);
			const outcome = await this.fetchAuction(mid);
			budget--;

			if (outcome.type === "found") {
				lowerBound = mid;
				bestAuction = outcome.data;
			} else if (outcome.type === "not_found") {
				upperBound = mid;
			} else {
				// error — don't treat as boundary
				return { id: lowerBound, auction: bestAuction };
			}
		}

		return { id: lowerBound, auction: bestAuction };
	}

	/** Reads the last 8 bytes of the most recent on-chain settle() calldata as big-endian int64. */
	private async getAuctionIdFromSettlement(): Promise<number | null> {
		const latestBlock = await this.publicClient.getBlockNumber();
		const fromBlock =
			latestBlock > SETTLEMENT_LOOKBACK_BLOCKS ? latestBlock - SETTLEMENT_LOOKBACK_BLOCKS : 0n;

		const logs = await this.publicClient.getLogs({
			address: this.settlementAddress,
			event: SETTLEMENT_EVENT,
			fromBlock,
			toBlock: "latest",
		});

		// Walk backwards through logs
		for (let i = logs.length - 1; i >= 0; i--) {
			const log = logs[i];
			if (!log) continue;
			const txHash = log.transactionHash;
			if (!txHash) continue;

			const tx = await this.publicClient.getTransaction({ hash: txHash });

			// Skip router transactions (not direct calls to settlement contract)
			if (tx.to?.toLowerCase() !== this.settlementAddress.toLowerCase()) continue;

			// Skip if not a settle() call or calldata too short
			if (!tx.input.startsWith(SETTLE_SELECTOR) || tx.input.length < 18) continue;

			return Number(BigInt(`0x${tx.input.slice(-16)}`));
		}

		return null;
	}

	private async fetchAuction(id: number): Promise<FetchOutcome> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		try {
			const response = await fetch(`${this.awsUrl}/autopilot/${id}.json`, {
				signal: controller.signal,
			});

			if (response.status === 404) return { type: "not_found" };
			if (!response.ok) return { type: "error" };

			const data = (await response.json()) as AutopilotDto;
			return { type: "found", data };
		} catch {
			return { type: "error" };
		} finally {
			clearTimeout(timer);
		}
	}
}
