import type { byosDomain } from "@byos/common";
import {
	type AuctionWork,
	type ByosClient,
	ByosRateLimitError,
	buildProposalFromRoute,
	canQuote,
	canSubmit,
	createTaskPool,
	type FyndProvider,
	type OrderbookOrder,
	type OrderFilter,
	prioritizeCandidates,
	type RequestBudget,
	randomNonce,
	streamQuotes,
	untilAborted,
} from "@byos/subsolver-core";
import { FyndError } from "@kayibal/fynd-client";
import type pino from "pino";
import type { Hex } from "viem";
import type { Config } from "./config.js";

/** Per-order refresh cooldown; individual alternatives remain owned by BYOS. */
interface Live {
	validUntil: bigint;
	lastSubmitted: bigint;
}

type Orderbook = Pick<import("@byos/subsolver-core").OrderbookClient, "solvableOrders">;

/** Polls Fynd and submits routes while keeping proposal state within the BYOS request budget. */
export class FyndSubsolver {
	private live = new Map<string, Live>();
	private hasSynchronized = true;
	private nextSynchronizationAt = 0n;
	private retryAtMs = 0;
	private readonly submissions: ReturnType<typeof createTaskPool>;

	constructor(
		private readonly config: Config,
		private readonly orderbook: Orderbook,
		private readonly byos: ByosClient,
		private readonly fynd: FyndProvider,
		private readonly domain: ReturnType<typeof byosDomain>,
		private readonly signFn: (params: unknown) => Promise<Hex>,
		private readonly logger: pino.Logger,
		private readonly budget: RequestBudget,
		private readonly orderFilter: OrderFilter,
	) {
		this.submissions = createTaskPool(config.byosSubmissionConcurrency ?? 3);
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
		try {
			if (!(await this.fynd.ready(work))) {
				this.logger.warn("Fynd sidecar is not ready; skipping this polling cycle");
				return;
			}
		} catch (error) {
			if (!canQuote(work)) return;
			this.logger.warn({ err: error }, "Fynd sidecar health check failed");
			return;
		}
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
		this.logger.debug({ count: candidates.length }, "sending candidates to Fynd for quoting");
		let routesFound = 0;
		let noRoute = 0;
		let errors = 0;
		let submissionErrors = 0;
		let stopped = false;
		await streamQuotes(
			this.fynd,
			candidates,
			async (result) => {
				const order = byUid.get(result.order.uid.toLowerCase());
				if (!order) return;
				if (result.error) {
					this.logQuoteError(result.error, order.uid);
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
					"Fynd route found",
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
							"Fynd proposal submitted",
						);
					} catch (error) {
						if (work?.signal.aborted) return;
						submissionErrors++;
						this.handleByosError(error, "Fynd proposal submission failed", order.uid);
						if (error instanceof ByosRateLimitError) stopped = true;
					}
				});
			},
			this.config.fyndQuoteConcurrency,
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

	private logQuoteError(error: unknown, orderUid: Hex): void {
		if (
			error instanceof FyndError &&
			(error.code === "NO_ROUTE_FOUND" || error.code === "INSUFFICIENT_LIQUIDITY")
		) {
			this.logger.debug({ code: error.code, orderUid }, "Fynd has no usable route");
			return;
		}
		if (error instanceof FyndError && error.isRetryable()) {
			this.logger.warn({ err: error, code: error.code, orderUid }, "Fynd transient quote error");
			return;
		}
		this.logger.warn({ err: error, orderUid }, "Fynd quote failed");
	}

	private handleByosError(error: unknown, message: string, orderUid?: Hex): void {
		if (error instanceof ByosRateLimitError) {
			this.retryAtMs = Date.now() + error.retryAfterMs;
			this.logger.warn(
				{ retryAfterMs: error.retryAfterMs, orderUid },
				"BYOS rate limited Fynd subsolver",
			);
			return;
		}
		this.logger.warn({ err: error, orderUid }, message);
	}
}
