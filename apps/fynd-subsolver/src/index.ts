import "dotenv/config";
import { byosDomain, TrampolineFactoryAbi } from "@byos/common";
import {
	ByosClient,
	ByosRateLimitError,
	buildProposalFromRoute,
	FyndConfigurationError,
	FyndProvider,
	OrderbookClient,
	type OrderbookOrder,
	prioritizeCandidates,
	quoteBatch,
	RequestBudget,
	randomNonce,
} from "@byos/subsolver-core";
import { FyndClient, FyndError } from "@kayibal/fynd-client";
import pino from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "./config.js";

interface Live {
	id: number;
	validUntil: bigint;
	lastSubmitted: bigint;
}
const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForFyndStartup(fynd: FyndProvider, logger: pino.Logger): Promise<void> {
	while (true) {
		try {
			await fynd.initialize();
			return;
		} catch (error) {
			if (error instanceof FyndConfigurationError) throw error;
			logger.warn({ err: error }, "waiting for Fynd sidecar info endpoint");
			await delay(2_000);
		}
	}
}

class FyndSubsolver {
	private live = new Map<string, Live>();
	private syncHealthy = false;
	private retryAtMs = 0;

	constructor(
		private readonly config: ReturnType<typeof parseConfig>,
		private readonly orderbook: OrderbookClient,
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
			this.live.clear();
			for (const proposal of await this.byos.proposals()) {
				if (this.byos.isTerminal(proposal.status) || proposal.validUntil < now) continue;
				this.live.set(proposal.orderUid.toLowerCase(), {
					id: proposal.id,
					validUntil: proposal.validUntil,
					lastSubmitted: now,
				});
			}
			this.syncHealthy = true;
			return true;
		} catch (error) {
			this.syncHealthy = false;
			this.handleByosError(error, "failed to synchronize BYOS proposal state");
			return false;
		}
	}

	async pollOnce(now: bigint): Promise<void> {
		if (Date.now() < this.retryAtMs || (!this.syncHealthy && !(await this.synchronize(now))))
			return;
		for (const [uid, live] of this.live) if (live.validUntil < now) this.live.delete(uid);
		let orders: OrderbookOrder[];
		try {
			orders = (await this.orderbook.solvableOrders()).filter((order) => order.kind === "sell");
		} catch (error) {
			this.logger.error({ err: error }, "failed to fetch solvable orders");
			return;
		}
		const candidates: OrderbookOrder[] = [];
		for (const order of orders) {
			const held = await this.holdsLiveProposal(order.uid);
			const live = this.live.get(order.uid.toLowerCase());
			if (
				!held ||
				(live && now - live.lastSubmitted >= BigInt(this.config.proposalRefreshIntervalSeconds))
			)
				candidates.push(order);
		}
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

	private async holdsLiveProposal(orderUid: Hex): Promise<boolean> {
		const live = this.live.get(orderUid.toLowerCase());
		if (!live || !this.budget.consumeRead()) return !!live;
		try {
			const view = await this.byos.proposal(live.id);
			if (!this.byos.isTerminal(view.status)) return true;
			this.live.delete(orderUid.toLowerCase());
			return false;
		} catch (error) {
			this.handleByosError(error, "failed to read proposal state", orderUid);
			return true;
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

async function main() {
	const config = parseConfig();
	const logger = pino({ level: config.logLevel, transport: { target: "pino-pretty" } });
	const transport = http(config.rpcUrl);
	const publicClient = createPublicClient({ transport });
	const account = privateKeyToAccount(config.privateKey);
	const trampoline = await publicClient.readContract({
		address: config.toml.trampolineFactory,
		abi: TrampolineFactoryAbi,
		functionName: "addressOf",
		args: [account.address],
	});
	logger.info({ trampoline, subSolver: account.address }, "resolved Fynd trampoline");
	const domain = byosDomain(config.toml.chainId, config.toml.trampolineFactory);
	const wallet = createWalletClient({ account, transport });
	const signFn = (params: unknown) => wallet.signTypedData(params as never);
	const fynd = new FyndProvider({
		client: new FyndClient({ baseUrl: config.fyndUrl, timeoutMs: 7000, retry: { maxAttempts: 2 } }),
		chainId: config.toml.chainId,
		trampoline: trampoline as Address,
		settlement: config.gpv2Settlement,
		slippageBps: config.fyndSlippageBps,
		maxQuoteAgeSeconds: config.fyndMaxQuoteAgeSeconds,
	});
	await waitForFyndStartup(fynd, logger);
	const subsolver = new FyndSubsolver(
		config,
		new OrderbookClient(config.orderBookUrl),
		new ByosClient(config.byosUrl, domain, signFn),
		fynd,
		domain,
		signFn,
		logger,
		new RequestBudget(config.byosRequestsPerMinute, config.byosReadReserve),
	);
	await subsolver.synchronize(BigInt(Math.floor(Date.now() / 1000)));
	const tick = async () => {
		try {
			await subsolver.pollOnce(BigInt(Math.floor(Date.now() / 1000)));
		} catch (error) {
			logger.warn({ err: error }, "poll failed");
		}
		timer = setTimeout(tick, config.toml.pollInterval * 1000);
	};
	let timer = setTimeout(tick, config.toml.pollInterval * 1000);
	const shutdown = () => {
		logger.info("shutting down");
		clearTimeout(timer);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((error) => {
	console.error("fatal:", error);
	process.exit(1);
});
