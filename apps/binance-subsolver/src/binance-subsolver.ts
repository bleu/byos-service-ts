import type { byosDomain } from "@byos/common";
import {
	type ByosClient,
	ByosRateLimitError,
	buildProposalFromRoute,
	type CandidateOrder,
	type OrderbookOrder,
	type OrderFilter,
	type ProviderRoute,
	prioritizeCandidates,
	quoteBatch,
	type RequestBudget,
	type RouteProvider,
	randomNonce,
	selectSlippageBps,
} from "@byos/subsolver-core";
import type pino from "pino";
import { type Address, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import type { BinanceClient } from "./binance-client.js";
import type { Config } from "./config.js";

/** Per-order refresh cooldown; individual alternatives remain owned by BYOS. */
interface Live {
	validUntil: bigint;
	lastSubmitted: bigint;
}

type Orderbook = Pick<import("@byos/subsolver-core").OrderbookClient, "solvableOrders">;

class BinanceProvider implements RouteProvider {
	readonly name = "binance";

	constructor(
		private readonly client: BinanceClient,
		private readonly trampoline: Address,
		private readonly settlement: Address,
		private readonly config: Pick<
			Config,
			"chainId" | "binanceSlippageBps" | "correlatedSlippageBps"
		>,
	) {}

	async quote(order: CandidateOrder): Promise<ProviderRoute | null> {
		return (await this.findRoutes(order, 1))[0] ?? null;
	}

	async quoteMany(order: CandidateOrder): Promise<ProviderRoute[]> {
		return this.findRoutes(order, 3);
	}

	private async findRoutes(order: CandidateOrder, limit: number): Promise<ProviderRoute[]> {
		const slippageBps = selectSlippageBps({
			chainId: this.config.chainId,
			sellToken: order.sellToken,
			buyToken: order.buyToken,
			defaultSlippageBps: this.config.binanceSlippageBps,
			correlatedSlippageBps: this.config.correlatedSlippageBps,
		});
		const quotes = await this.client.getQuotes(
			order.sellToken,
			order.buyToken,
			order.remainingSell,
			this.trampoline,
			slippageBps,
		);
		if (quotes.length === 0) return [];

		// Build independently: a vendor failure must not discard another route.
		const built = await Promise.allSettled(
			quotes.map(async (quote) => ({
				quote,
				swapTx: await this.client.buildSwap(
					quote.quoteId,
					order.sellToken,
					order.buyToken,
					order.remainingSell,
					this.trampoline,
					slippageBps,
				),
			})),
		);
		const pairs = built.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		pairs.sort((a, b) => a.swapTx.data.length - b.swapTx.data.length);
		const routes: ProviderRoute[] = [];
		const seen = new Set<string>();
		for (const { quote, swapTx } of pairs) {
			if (BigInt(swapTx.minReceiveAmount) < order.scaledLimitBuy) continue;
			const key = `${quote.approveTarget.toLowerCase()}:${swapTx.to.toLowerCase()}:${swapTx.value}:${swapTx.data.toLowerCase()}:${swapTx.minReceiveAmount}`;
			if (seen.has(key)) continue;
			seen.add(key);

			// approveTarget is the contract that pulls sellTokens during the swap.
			const interactions: ProviderRoute["interactions"] = [
				{
					target: order.sellToken,
					value: 0n,
					callData: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [quote.approveTarget, maxUint256],
					}),
				},
			];

			const minBuyAmount = BigInt(swapTx.minReceiveAmount);

			interactions.push({
				target: swapTx.to,
				value: BigInt(swapTx.value || "0"),
				callData: swapTx.data,
			});

			// Binance sends buyTokens to userWalletAddress (trampoline), not to
			// settlement. Transfer the guaranteed minimum to settlement so the
			// Trampoline's floor check (settlement buy balance delta) passes.
			// Any surplus above minReceiveAmount stays in the trampoline and can
			// be recovered via claimToken.
			interactions.push({
				target: order.buyToken,
				value: 0n,
				callData: encodeFunctionData({
					abi: erc20Abi,
					functionName: "transfer",
					args: [this.settlement, minBuyAmount],
				}),
			});

			routes.push({
				quoteBuyAmount: minBuyAmount,
				minBuyAmount,
				interactions,
			});
			if (routes.length === limit) break;
		}
		return routes;
	}
}

/** Polls Binance and submits routes while keeping proposal state within the BYOS request budget. */
export class BinanceSubsolver {
	private live = new Map<string, Live>();
	private hasSynchronized = true;
	private nextSynchronizationAt = 0n;
	private retryAtMs = 0;
	private readonly provider: BinanceProvider;

	constructor(
		private readonly config: Config,
		private readonly orderbook: Orderbook,
		private readonly byos: ByosClient,
		binanceClient: BinanceClient,
		readonly trampoline: Address,
		private readonly domain: ReturnType<typeof byosDomain>,
		private readonly signFn: (params: unknown) => Promise<`0x${string}`>,
		private readonly logger: pino.Logger,
		private readonly budget: RequestBudget,
		private readonly orderFilter: OrderFilter,
	) {
		this.provider = new BinanceProvider(binanceClient, trampoline, config.gpv2Settlement, config);
	}

	async synchronize(now: bigint): Promise<boolean> {
		if (!this.budget.consumeRead()) return false;
		try {
			const next = new Map<string, Live>();
			for (const proposal of await this.byos.proposals()) {
				if (this.byos.isTerminal(proposal.status) || proposal.validUntil < now) continue;
				const uid = proposal.orderUid.toLowerCase();
				const previous = next.get(uid);
				next.set(uid, {
					validUntil:
						previous && previous.validUntil > proposal.validUntil
							? previous.validUntil
							: proposal.validUntil,
					lastSubmitted: now,
				});
			}
			this.live = next;
			this.hasSynchronized = true;
			this.nextSynchronizationAt = now + BigInt(this.config.proposalRefreshIntervalSeconds);
			return true;
		} catch (error) {
			if (this.hasSynchronized) {
				this.nextSynchronizationAt = now + BigInt(this.config.proposalRefreshIntervalSeconds);
			}
			this.handleByosError(error, "failed to synchronize BYOS proposal state");
			return false;
		}
	}

	async pollOnce(now: bigint): Promise<void> {
		let orders: OrderbookOrder[];
		try {
			const raw = await this.orderbook.solvableOrders();
			orders = this.orderFilter.filter(raw);
		} catch (error) {
			this.logger.error({ err: error }, "failed to fetch solvable orders");
			return;
		}
		if (Date.now() < this.retryAtMs) return;
		if (!this.hasSynchronized) {
			if (!(await this.synchronize(now))) return;
		} else if (now >= this.nextSynchronizationAt) {
			await this.synchronize(now);
		}
		for (const [uid, live] of this.live) if (live.validUntil < now) this.live.delete(uid);
		this.logger.debug(
			{ count: orders.length, liveProposals: this.live.size },
			"fetched solvable sell orders",
		);
		const candidates = orders.filter((order) => {
			const live = this.live.get(order.uid.toLowerCase());
			return (
				!live || now - live.lastSubmitted >= BigInt(this.config.proposalRefreshIntervalSeconds)
			);
		});
		this.logger.debug(
			{ total: orders.length, candidates: candidates.length },
			"filtered candidates (excluding recently submitted)",
		);
		if (candidates.length === 0) return;
		await this.submitRoutes(candidates, now);
	}

	private async submitRoutes(orders: readonly OrderbookOrder[], now: bigint): Promise<void> {
		const byUid = new Map(orders.map((order) => [order.uid.toLowerCase(), order]));
		const candidates = prioritizeCandidates(
			orders.map((order) => ({
				...order,
				chainId: this.config.chainId,
				executedSellAmount: order.fullSellAmount - order.sellAmount,
			})),
			(uid) => this.live.has(uid.toLowerCase()),
		).map((ranked) => ranked.candidate);
		this.logger.debug({ count: candidates.length }, "sending candidates to Binance for quoting");
		const results = await quoteBatch(
			this.provider,
			candidates,
			this.config.binanceQuoteConcurrency,
		);
		let routesFound = 0;
		let noRoute = 0;
		let errors = 0;
		for (const result of results) {
			const order = byUid.get(result.order.uid.toLowerCase());
			if (!order) continue;
			if (result.error) {
				this.logger.warn({ err: result.error, orderUid: order.uid }, "Binance quote failed");
				errors++;
				continue;
			}
			if (!result.route) {
				noRoute++;
				continue;
			}
			routesFound++;
			this.logger.debug(
				{
					orderUid: order.uid,
					sellToken: order.sellToken,
					buyToken: order.buyToken,
					remainingSell: result.order.remainingSell.toString(),
					scaledLimitBuy: result.order.scaledLimitBuy.toString(),
					minBuyAmount: result.route.minBuyAmount.toString(),
					quoteBuyAmount: result.route.quoteBuyAmount.toString(),
					interactions: result.route.interactions.length,
				},
				"Binance route found",
			);
			if (!this.budget.consumeSubmission()) {
				this.logger.info("BYOS submission budget reserved for proposal state reads");
				return;
			}
			try {
				const validUntil = now + BigInt(this.config.proposalTtlSeconds);
				const proposal = await buildProposalFromRoute(
					{
						...order,
						sellAmount: result.order.remainingSell,
						buyAmount: result.order.scaledLimitBuy,
					},
					result.route,
					validUntil,
					randomNonce(),
					this.domain,
					this.signFn,
				);
				if (!proposal) {
					this.logger.debug(
						{
							orderUid: order.uid,
							minBuyAmount: result.route.minBuyAmount.toString(),
							scaledLimitBuy: result.order.scaledLimitBuy.toString(),
						},
						"proposal rejected by buildProposalFromRoute (minBuyAmount < scaledLimitBuy or buy-order kind)",
					);
					continue;
				}
				this.logger.debug(
					{
						orderUid: proposal.orderUid,
						sellToken: proposal.sellToken,
						buyToken: proposal.buyToken,
						sellAmount: proposal.sellAmount.toString(),
						minBuyAmount: proposal.minBuyAmount.toString(),
						quoteBuyAmount: proposal.quoteBuyAmount.toString(),
						validUntil: proposal.validUntil.toString(),
						nonce: proposal.nonce.toString(),
						interactions: proposal.interactions.length,
					},
					"submitting proposal to BYOS",
				);
				const id = await this.byos.submit(proposal);
				this.live.set(order.uid.toLowerCase(), { validUntil, lastSubmitted: now });
				this.logger.info({ id, orderUid: order.uid }, "Binance proposal submitted");
			} catch (error) {
				this.handleByosError(error, "Binance proposal submission failed", order.uid);
				if (error instanceof ByosRateLimitError) return;
			}
		}
		this.logger.info(
			{ routesFound, noRoute, errors, total: candidates.length },
			"poll cycle complete",
		);
	}

	private handleByosError(error: unknown, message: string, orderUid?: `0x${string}`): void {
		if (error instanceof ByosRateLimitError) {
			this.retryAtMs = Date.now() + error.retryAfterMs;
			this.logger.warn(
				{ retryAfterMs: error.retryAfterMs, orderUid },
				"BYOS rate limited Binance subsolver",
			);
			return;
		}
		this.logger.warn({ err: error, orderUid }, message);
	}
}
