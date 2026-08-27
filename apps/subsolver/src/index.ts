import "dotenv/config";
import { byosDomain } from "@byos/common";
import {
	buildProposalFromRoute,
	FyndConfigurationError,
	FyndProvider,
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
import { buildProposal, type Order } from "./domain/proposal.js";
import { pairAddress } from "./domain/routing.js";
import { ChainClient, type ReservesQuery } from "./infra/blockchain.js";
import { ByosClient, ByosRateLimitError } from "./infra/byos.js";
import { OrderbookClient } from "./infra/orderbook.js";

interface Live {
	id: number;
	validUntil: bigint;
	lastSubmitted: bigint;
}

const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Retry transport/warm-up failures, but fail fast on an invalid Fynd setup. */
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

class Subsolver {
	private live = new Map<string, Live>();
	private syncHealthy = false;
	private retryAtMs = 0;

	constructor(
		private readonly config: ReturnType<typeof parseConfig>,
		private readonly orderbook: OrderbookClient,
		private readonly byos: ByosClient,
		private readonly chain: ChainClient,
		private readonly domain: ReturnType<typeof byosDomain>,
		private readonly trampoline: Address,
		private readonly fynd: FyndProvider | null,
		// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
		private readonly signFn: (params: any) => Promise<Hex>,
		private readonly logger: pino.Logger,
		private readonly budget: RequestBudget,
	) {}

	/** Recover current proposals before submitting anything after a restart. */
	async synchronize(now: bigint): Promise<boolean> {
		if (!this.budget.consumeRead()) return false;
		try {
			const proposals = await this.byos.proposals();
			this.live.clear();
			for (const proposal of proposals) {
				if (this.byos.isTerminal(proposal.status) || proposal.validUntil <= now) continue;
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
		if (Date.now() < this.retryAtMs) return;
		if (!this.syncHealthy && !(await this.synchronize(now))) return;
		// Cleanup expired proposals
		for (const [uid, live] of this.live) {
			if (live.validUntil <= now) {
				this.live.delete(uid);
			}
		}

		// Discover solvable orders
		let orders: Order[];
		try {
			orders = await this.orderbook.solvableOrders();
		} catch (e) {
			this.logger.error({ err: e }, "failed to fetch solvable orders");
			return;
		}

		// Filter to orders without a live proposal
		const pending: Order[] = [];
		const refreshes: Order[] = [];
		for (const order of orders) {
			const held = await this.holdsLiveProposal(order.uid);
			if (!held) {
				pending.push(order);
				continue;
			}
			const live = this.live.get(order.uid.toLowerCase());
			if (live && now - live.lastSubmitted >= BigInt(this.config.proposalRefreshIntervalSeconds)) {
				refreshes.push(order);
			}
		}

		if (pending.length === 0 && refreshes.length === 0) return;
		if (this.fynd) {
			try {
				if (!(await this.fynd.ready())) {
					this.logger.warn("Fynd sidecar is not ready; skipping this polling cycle");
					return;
				}
			} catch (e) {
				this.logger.warn({ err: e }, "Fynd sidecar health check failed");
				return;
			}
			await this.submitFyndRoutes([...pending, ...refreshes], now);
			return;
		}

		// Batch fetch reserves (single multicall)
		const candidates = [...pending, ...refreshes];
		const queries: ReservesQuery[] = candidates.map((o) => ({
			pair: pairAddress(
				this.config.toml.uniswapFactory,
				this.config.toml.pairInitCodeHash,
				o.sellToken,
				o.buyToken,
			),
			sellToken: o.sellToken,
			buyToken: o.buyToken,
		}));

		let reserves: Awaited<ReturnType<typeof this.chain.reserves>>;
		try {
			reserves = await this.chain.reserves(queries);
		} catch (e) {
			this.logger.error({ err: e }, "failed to fetch reserves");
			return;
		}

		// Per-order proposal
		for (let i = 0; i < candidates.length; i++) {
			const order = candidates[i]!;
			const reserve = reserves[i];
			if (!reserve) continue;

			try {
				if (!this.budget.consumeSubmission()) return;
				const result = await this.propose(order, reserve.reserveSell, reserve.reserveBuy, now);
				if (result) {
					this.live.set(order.uid.toLowerCase(), result);
					this.logger.info({ id: result.id, orderUid: order.uid }, "proposal submitted");
				}
			} catch (error) {
				this.handleByosError(error, "proposal failed", order.uid);
			}
		}
	}

	private async submitFyndRoutes(orders: readonly Order[], now: bigint): Promise<void> {
		const byUid = new Map(orders.map((order) => [order.uid.toLowerCase(), order]));
		const newOrderUids = new Set(
			orders
				.filter((order) => !this.live.has(order.uid.toLowerCase()))
				.map((order) => order.uid.toLowerCase()),
		);
		const candidates = prioritizeCandidates(
			orders
				.filter((order) => order.kind === "sell")
				.map((order) => {
					const fullSellAmount = order.fullSellAmount ?? order.sellAmount;
					return {
						uid: order.uid,
						chainId: this.config.toml.chainId,
						sellToken: order.sellToken,
						buyToken: order.buyToken,
						fullSellAmount,
						fullBuyAmount: order.fullBuyAmount ?? order.buyAmount,
						executedSellAmount: fullSellAmount - order.sellAmount,
						estimatedNativeSurplus: order.estimatedNativeSurplus,
					};
				}),
			(orderUid) => !newOrderUids.has(orderUid.toLowerCase()),
		).map((ranked) => ranked.candidate);
		const results = await quoteBatch(this.fynd!, candidates, this.config.fyndQuoteConcurrency);
		for (const result of results) {
			const order = byUid.get(result.order.uid.toLowerCase());
			if (!order) continue;
			if (result.error) {
				this.logFyndQuoteError(result.error, order.uid);
				continue;
			}
			if (!result.route) continue;
			if (!this.budget.consumeSubmission()) {
				this.logger.info("BYOS submission budget reserved for proposal state reads");
				return;
			}
			try {
				const candidateOrder: Order = {
					...order,
					sellAmount: result.order.remainingSell,
					buyAmount: result.order.scaledLimitBuy,
				};
				const validUntil = now + BigInt(this.config.toml.proposalTtl);
				const proposal = await buildProposalFromRoute(
					candidateOrder,
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

	private logFyndQuoteError(error: unknown, orderUid: Hex): void {
		if (error instanceof FyndError) {
			if (error.code === "NO_ROUTE_FOUND" || error.code === "INSUFFICIENT_LIQUIDITY") {
				this.logger.debug({ code: error.code, orderUid }, "Fynd has no usable route");
				return;
			}
			if (error.isRetryable()) {
				this.logger.warn({ err: error, code: error.code, orderUid }, "Fynd transient quote error");
				return;
			}
			this.logger.error({ err: error, code: error.code, orderUid }, "Fynd invalid quote request");
			return;
		}
		this.logger.warn({ err: error, orderUid }, "unexpected Fynd quote error");
	}

	private async holdsLiveProposal(orderUid: Hex): Promise<boolean> {
		const key = orderUid.toLowerCase();
		const live = this.live.get(key);
		if (!live) return false;

		if (!this.budget.consumeRead()) return true;
		try {
			const view = await this.byos.proposal(live.id);
			if (this.byos.isTerminal(view.status)) {
				if (view.rejectionReason === "UnsupportedOrder") {
					this.logger.warn({ id: live.id, reason: view.rejectionReason }, "envelope mismatch");
				}
				this.live.delete(key);
				return false;
			}
			return true;
		} catch (error) {
			this.handleByosError(error, "failed to read proposal state", orderUid);
			// Poll failure: hold optimistically
			return true;
		}
	}

	private handleByosError(error: unknown, message: string, orderUid?: Hex): void {
		if (error instanceof ByosRateLimitError) {
			this.retryAtMs = Date.now() + error.retryAfterMs;
			this.logger.warn(
				{ retryAfterMs: error.retryAfterMs, orderUid },
				"BYOS rate limited subsolver",
			);
			return;
		}
		this.logger.warn({ err: error, orderUid }, message);
	}

	private async propose(
		order: Order,
		reserveSell: bigint,
		reserveBuy: bigint,
		now: bigint,
	): Promise<Live | null> {
		const validUntil = now + BigInt(this.config.toml.proposalTtl);
		const nonce = randomNonce();

		const proposal = await buildProposal(
			order,
			{
				router: this.config.toml.uniswapRouter,
				trampoline: this.trampoline,
				reserveSell,
				reserveBuy,
				validUntil,
				nonce,
				extraInteractions: [],
			},
			this.domain,
			this.signFn,
		);

		if (!proposal) return null;

		const id = await this.byos.submit(proposal);
		return { id, validUntil, lastSubmitted: now };
	}
}

async function main() {
	const config = parseConfig();

	const logger = pino({
		level: config.logLevel,
		transport: { target: "pino-pretty" },
	});

	// Blockchain client
	const transport = http(config.rpcUrl);
	const publicClient = createPublicClient({ transport });
	const account = privateKeyToAccount(config.privateKey);
	const walletClient = createWalletClient({ account, transport });

	const chain = new ChainClient(publicClient);

	// Resolve trampoline address
	const trampoline = await chain.trampoline(config.toml.trampolineFactory, account.address);
	logger.info({ trampoline, subSolver: account.address }, "resolved trampoline");

	// EIP-712 domain
	const domain = byosDomain(config.toml.chainId, config.toml.trampolineFactory);

	// Sign function
	// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
	const signFn = (params: any) => walletClient.signTypedData(params);

	// Clients
	const orderbook = new OrderbookClient(config.orderBookUrl);
	const byos = new ByosClient(config.byosUrl, domain, signFn);
	const fynd =
		config.provider === "fynd"
			? new FyndProvider({
					client: new FyndClient({
						baseUrl: config.fyndUrl ?? "http://fynd:3000",
						timeoutMs: 7000,
						retry: { maxAttempts: 2 },
					}),
					chainId: config.toml.chainId,
					trampoline,
					settlement: config.gpv2Settlement!,
					slippageBps: config.fyndSlippageBps,
					maxQuoteAgeSeconds: config.fyndMaxQuoteAgeSeconds,
				})
			: null;
	if (fynd) await waitForFyndStartup(fynd, logger);

	// Subsolver
	const subsolver = new Subsolver(
		config,
		orderbook,
		byos,
		chain,
		domain,
		trampoline,
		fynd,
		signFn,
		logger,
		new RequestBudget(config.byosRequestsPerMinute, config.byosReadReserve),
	);
	await subsolver.synchronize(BigInt(Math.floor(Date.now() / 1000)));

	// Main loop
	const pollInterval = config.toml.pollInterval * 1000;
	logger.info({ pollInterval: config.toml.pollInterval }, "starting polling loop");

	const tick = async () => {
		const now = BigInt(Math.floor(Date.now() / 1000));
		try {
			await subsolver.pollOnce(now);
		} catch (e) {
			logger.warn({ err: e }, "poll failed");
		}
		timer = setTimeout(tick, pollInterval);
	};

	let timer = setTimeout(tick, pollInterval);

	// Graceful shutdown
	const shutdown = () => {
		logger.info("shutting down");
		clearTimeout(timer);
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
