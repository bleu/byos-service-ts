import "dotenv/config";
import { byosDomain } from "@byos/common";
import { randomNonce } from "@byos/subsolver-core";
import pino from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "./config.js";
import { buildProposal, type Order } from "./domain/proposal.js";
import { pairAddress } from "./domain/routing.js";
import { ChainClient, type ReservesQuery } from "./infra/blockchain.js";
import { ByosClient } from "./infra/byos.js";
import { OrderbookClient } from "./infra/orderbook.js";

interface Live {
	id: number;
	validUntil: bigint;
	lastSubmitted: bigint;
}

class Subsolver {
	private live = new Map<string, Live>();

	constructor(
		private readonly config: ReturnType<typeof parseConfig>,
		private readonly orderbook: OrderbookClient,
		private readonly byos: ByosClient,
		private readonly chain: ChainClient,
		private readonly domain: ReturnType<typeof byosDomain>,
		private readonly trampoline: Address,
		// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
		private readonly signFn: (params: any) => Promise<Hex>,
		private readonly logger: pino.Logger,
	) {}

	async pollOnce(now: bigint): Promise<void> {
		// Cleanup expired proposals
		for (const [uid, live] of this.live) {
			if (live.validUntil < now) {
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
		for (const order of orders) {
			const held = await this.holdsLiveProposal(order.uid);
			if (!held) pending.push(order);
		}

		if (pending.length === 0) return;

		// Batch fetch reserves (single multicall)
		const candidates = pending;
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
			const order = candidates[i];
			const reserve = reserves[i];
			if (!order || !reserve) continue;

			try {
				const result = await this.propose(order, reserve.reserveSell, reserve.reserveBuy, now);
				if (result) {
					this.live.set(order.uid.toLowerCase(), result);
					this.logger.info({ id: result.id, orderUid: order.uid }, "proposal submitted");
				}
			} catch (error) {
				this.logger.warn({ err: error, orderUid: order.uid }, "proposal failed");
			}
		}
	}

	private async holdsLiveProposal(orderUid: Hex): Promise<boolean> {
		const key = orderUid.toLowerCase();
		const live = this.live.get(key);
		if (!live) return false;

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
		} catch {
			// Poll failure: hold optimistically
			return true;
		}
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
	// Subsolver
	const subsolver = new Subsolver(
		config,
		orderbook,
		byos,
		chain,
		domain,
		trampoline,
		signFn,
		logger,
	);

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
