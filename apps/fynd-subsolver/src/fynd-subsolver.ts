import type { byosDomain } from "@byos/common";
import {
	type ByosClient,
	ByosRateLimitError,
	buildProposalFromRoute,
	type FyndProvider,
	type OrderbookOrder,
	prioritizeCandidates,
	quoteBatch,
	type RequestBudget,
	randomNonce,
} from "@byos/subsolver-core";
import { FyndError } from "@kayibal/fynd-client";
import type pino from "pino";
import type { Hex } from "viem";
import type { Config } from "./config.js";

interface Live {
	id: number;
	validUntil: bigint;
	lastSubmitted: bigint;
}

type Orderbook = Pick<import("@byos/subsolver-core").OrderbookClient, "solvableOrders">;

/** Polls Fynd and submits routes while keeping proposal state within the BYOS request budget. */
export class FyndSubsolver {
	private live = new Map<string, Live>();
	private hasSynchronized = false;
	private nextSynchronizationAt = 0n;
	private retryAtMs = 0;

	constructor(
		private readonly config: Config,
		private readonly orderbook: Orderbook,
		private readonly byos: ByosClient,
		private readonly fynd: FyndProvider,
		private readonly domain: ReturnType<typeof byosDomain>,
		private readonly signFn: (params: unknown) => Promise<Hex>,
		private readonly logger: pino.Logger,
		private readonly budget: RequestBudget,
	) {}

	async synchronize(now: bigint): Promise<boolean> {
		if (!this.budget.consumeRead()) return false;
		try {
			const next = new Map<string, Live>();
			for (const proposal of await this.byos.proposals()) {
				if (this.byos.isTerminal(proposal.status) || proposal.validUntil < now) continue;
				next.set(proposal.orderUid.toLowerCase(), {
					id: proposal.id,
					validUntil: proposal.validUntil,
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
		if (Date.now() < this.retryAtMs) return;
		if (!this.hasSynchronized) {
			if (!(await this.synchronize(now))) return;
		} else if (now >= this.nextSynchronizationAt) {
			await this.synchronize(now);
		}
		for (const [uid, live] of this.live) if (live.validUntil < now) this.live.delete(uid);
		let orders: OrderbookOrder[];
		try {
			orders = (await this.orderbook.solvableOrders()).filter((order) => order.kind === "sell");
		} catch (error) {
			this.logger.error({ err: error }, "failed to fetch solvable orders");
			return;
		}
		const candidates = orders.filter((order) => {
			const live = this.live.get(order.uid.toLowerCase());
			return (
				!live || now - live.lastSubmitted >= BigInt(this.config.proposalRefreshIntervalSeconds)
			);
		});
		if (candidates.length === 0) return;
		try {
			if (!(await this.fynd.ready())) {
				this.logger.warn("Fynd sidecar is not ready; skipping this polling cycle");
				return;
			}
		} catch (error) {
			this.logger.warn({ err: error }, "Fynd sidecar health check failed");
			return;
		}
		await this.submitRoutes(candidates, now);
	}

	private async submitRoutes(orders: readonly OrderbookOrder[], now: bigint): Promise<void> {
		const byUid = new Map(orders.map((order) => [order.uid.toLowerCase(), order]));
		const candidates = prioritizeCandidates(
			orders.map((order) => ({
				...order,
				chainId: this.config.toml.chainId,
				executedSellAmount: order.fullSellAmount - order.sellAmount,
			})),
			(uid) => this.live.has(uid.toLowerCase()),
		).map((ranked) => ranked.candidate);
		for (const result of await quoteBatch(
			this.fynd,
			candidates,
			this.config.fyndQuoteConcurrency,
		)) {
			const order = byUid.get(result.order.uid.toLowerCase());
			if (!order) continue;
			if (result.error) {
				this.logQuoteError(result.error, order.uid);
				continue;
			}
			if (!result.route) continue;
			if (!this.budget.consumeSubmission()) {
				this.logger.info("BYOS submission budget reserved for proposal state reads");
				return;
			}
			try {
				const validUntil = now + BigInt(this.config.toml.proposalTtl);
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
				if (!proposal) continue;
				const id = await this.byos.submit(proposal);
				this.live.set(order.uid.toLowerCase(), { id, validUntil, lastSubmitted: now });
				this.logger.info({ id, orderUid: order.uid }, "Fynd proposal submitted");
			} catch (error) {
				this.handleByosError(error, "Fynd proposal submission failed", order.uid);
			}
		}
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
