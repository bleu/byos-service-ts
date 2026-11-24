import type { byosDomain } from "@byos/common";
import {
	type AuctionWork,
	type ByosClient,
	ByosRateLimitError,
	buildProposalFromRoute,
	type CandidateOrder,
	canQuote,
	canSubmit,
	createTaskPool,
	type OrderbookOrder,
	type OrderFilter,
	type ProviderRoute,
	prioritizeCandidates,
	type RequestBudget,
	type RouteProvider,
	randomNonce,
	selectSlippageBps,
	streamQuotes,
	untilAborted,
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

	async quote(order: CandidateOrder, work?: AuctionWork): Promise<ProviderRoute | null> {
		return (await this.findRoutes(order, 1, work))[0] ?? null;
	}

	async quoteMany(order: CandidateOrder, work?: AuctionWork): Promise<ProviderRoute[]> {
		return this.findRoutes(order, 3, work);
	}

	private async findRoutes(
		order: CandidateOrder,
		limit: number,
		work?: AuctionWork,
	): Promise<ProviderRoute[]> {
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
			work,
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
					work,
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
	private readonly submissions: ReturnType<typeof createTaskPool>;
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
		this.submissions = createTaskPool(config.byosSubmissionConcurrency ?? 3);
		this.provider = new BinanceProvider(binanceClient, trampoline, config.gpv2Settlement, config);
	}

	async synchronize(now: bigint, work?: AuctionWork): Promise<boolean> {
		if (!this.budget.consumeRead()) return false;
		try {
			const next = new Map<string, Live>();
			for (const proposal of await this.byos.proposals(work)) {
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
			if (work?.signal.aborted) return false;
			if (this.hasSynchronized) {
				this.nextSynchronizationAt = now + BigInt(this.config.proposalRefreshIntervalSeconds);
			}
			this.handleByosError(error, "failed to synchronize BYOS proposal state");
			return false;
		}
	}

	async pollOnce(now: bigint, work?: AuctionWork): Promise<void> {
		if (!canQuote(work)) return;
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
			if (!(await this.synchronize(now, work))) return;
		} else if (now >= this.nextSynchronizationAt) {
			await this.synchronize(now, work);
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
		if (canQuote(work)) await this.submitRoutes(candidates, now, work);
	}

	private async submitRoutes(
		orders: readonly OrderbookOrder[],
		now: bigint,
		work?: AuctionWork,
	): Promise<void> {
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
		let routesFound = 0;
		let noRoute = 0;
		let errors = 0;
		let submissionErrors = 0;
		let stopped = false;
		await streamQuotes(
			this.provider,
			candidates,
			async (result) => {
				const order = byUid.get(result.order.uid.toLowerCase());
				if (!order) return;
				if (result.error) {
					this.logger.warn(
						{ err: result.error, orderUid: order.uid, auctionId: work?.auctionId },
						"Binance quote failed",
					);
					errors++;
					return;
				}
				const route = result.route;
				if (!route) {
					noRoute++;
					return;
				}
				routesFound++;
				this.logger.debug(
					{
						orderUid: order.uid,
						auctionId: work?.auctionId,
						nativeSellValue: result.order.nativeSellValue?.toString(),
						quoteElapsedMs: result.quoteElapsedMs,
						minBuyAmount: route.minBuyAmount.toString(),
						quoteBuyAmount: route.quoteBuyAmount.toString(),
					},
					"Binance route found",
				);
				await this.submissions.run(async () => {
					const blocked = () => stopped || Date.now() < this.retryAtMs || !canSubmit(work);
					if (blocked()) return;
					try {
						const validUntil = now + BigInt(this.config.proposalTtlSeconds);
						const signing = buildProposalFromRoute(
							{
								...order,
								sellAmount: result.order.remainingSell,
								buyAmount: result.order.scaledLimitBuy,
							},
							route,
							validUntil,
							randomNonce(),
							this.domain,
							this.signFn,
						);
						const proposal = await (work ? untilAborted(signing, work.signal) : signing);
						if (!proposal) return;
						if (blocked()) return;
						if (!this.budget.consumeSubmission()) {
							stopped = true;
							this.logger.info("BYOS submission budget reserved for proposal state reads");
							return;
						}
						const startedAt = Date.now();
						this.logger.debug(
							{
								orderUid: order.uid,
								auctionId: work?.auctionId,
								nonce: proposal.nonce.toString(),
								remainingMs: work ? work.deadlineMs - startedAt : undefined,
							},
							"submitting proposal to BYOS",
						);
						const sending = this.byos.submit(proposal, work);
						const id = await (work ? untilAborted(sending, work.signal) : sending);
						this.live.set(order.uid.toLowerCase(), { validUntil, lastSubmitted: now });
						this.logger.info(
							{
								id,
								orderUid: order.uid,
								auctionId: work?.auctionId,
								quoteElapsedMs: result.quoteElapsedMs,
								postElapsedMs: Date.now() - startedAt,
								remainingMs: work ? work.deadlineMs - Date.now() : undefined,
							},
							"Binance proposal submitted",
						);
					} catch (error) {
						if (work?.signal.aborted) return;
						submissionErrors++;
						this.handleByosError(error, "Binance proposal submission failed", order.uid);
						if (error instanceof ByosRateLimitError) stopped = true;
					}
				});
			},
			this.config.binanceQuoteConcurrency,
			work,
		);
		this.logger.info(
			{
				auctionId: work?.auctionId,
				deadlineMs: work?.deadlineMs,
				routesFound,
				noRoute,
				errors,
				submissionErrors,
				total: candidates.length,
			},
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
