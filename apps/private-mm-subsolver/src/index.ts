import "dotenv/config";
import type { ContractInteraction } from "@byos/common";
import { byosDomain, signProposal } from "@byos/common";
import type { OrderbookOrder, ProposalMetadata } from "@byos/subsolver-core";
import { ByosClient, OrderbookClient } from "@byos/subsolver-core";
import pino from "pino";
import type { Hex } from "viem";
import { encodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "./config.js";
import { filterCandidates } from "./filter.js";

const erc20TransferAbi = [
	{
		name: "transfer",
		type: "function" as const,
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ type: "bool" }],
		stateMutability: "nonpayable" as const,
	},
];

interface CachedProposal {
	proposalId: number;
	validUntil: bigint;
	status: "active" | "deactivated";
}

async function main() {
	const config = parseConfig();

	const logger = pino({
		level: config.logLevel,
		transport: { target: "pino-pretty" },
	});

	const account = privateKeyToAccount(config.privateKey);
	// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
	const signFn = (params: any) => account.signTypedData(params);

	const domain = byosDomain(config.chainId, config.trampolineFactory);
	const orderbook = new OrderbookClient(config.orderbookUrl);
	const byos = new ByosClient(config.byosUrl, domain, signFn);

	// Keyed by orderUid.toLowerCase()
	const proposals = new Map<string, CachedProposal>();

	// Nonce: timestamp at startup + incrementing counter to survive restarts safely
	let nonce = BigInt(Date.now());
	const nextNonce = (): bigint => {
		const current = nonce;
		nonce += 1n;
		return current;
	};

	// Static trampoline balances — no RPC needed for shadow competition
	const trampolineBalance = new Map<string, bigint>([
		[config.usdcAddress.toLowerCase(), config.usdcBalance],
		[config.usdtAddress.toLowerCase(), config.usdtBalance],
	]);

	// --- Main orderbook polling loop ---
	const pollOrderbook = async (): Promise<void> => {
		const nowSecs = BigInt(Math.floor(Date.now() / 1000));

		let orders: OrderbookOrder[];
		try {
			orders = await orderbook.solvableOrders();
		} catch (err) {
			logger.error({ err }, "failed to fetch solvable orders");
			return;
		}

		const candidates = filterCandidates(orders, {
			usdcAddress: config.usdcAddress,
			usdtAddress: config.usdtAddress,
			trampolineBalance,
			trackedUids: new Set(proposals.keys()),
		});

		logger.info({ total: orders.length, candidates: candidates.length }, "orderbook fetched");

		for (const order of candidates) {
			const validUntil = nowSecs + config.maxProposalLifetimeSecs;

			const interactions: ContractInteraction[] = [
				{
					target: order.buyToken,
					value: 0n,
					callData: encodeFunctionData({
						abi: erc20TransferAbi,
						functionName: "transfer",
						args: [config.settlementAddress, order.sellAmount],
					}) as Hex,
				},
			];

			const proposal = {
				orderUidHash: keccak256(order.uid),
				sellToken: order.sellToken,
				buyToken: order.buyToken,
				sellAmount: order.sellAmount,
				minBuyAmount: order.sellAmount, // 1:1
				quoteBuyAmount: order.sellAmount, // 1:1
				validUntil,
				nonce: nextNonce(),
			};

			let signature: Hex;
			try {
				signature = await signProposal(signFn, domain, proposal, interactions);
			} catch (err) {
				logger.warn({ err, orderUid: order.uid }, "failed to sign proposal");
				continue;
			}

			try {
				const id = await byos.submit({
					orderUid: order.uid,
					sellToken: order.sellToken,
					buyToken: order.buyToken,
					sellAmount: order.sellAmount,
					minBuyAmount: proposal.minBuyAmount,
					quoteBuyAmount: proposal.quoteBuyAmount,
					interactions,
					validUntil,
					nonce: proposal.nonce,
					signature,
				});
				proposals.set(order.uid.toLowerCase(), { proposalId: id, validUntil, status: "active" });
				logger.info(
					{
						id,
						orderUid: order.uid,
						sellToken: order.sellToken,
						buyToken: order.buyToken,
						sellAmount: order.sellAmount.toString(),
						minBuyAmount: proposal.minBuyAmount.toString(),
						quoteBuyAmount: proposal.quoteBuyAmount.toString(),
						validUntil: validUntil.toString(),
						nonce: proposal.nonce.toString(),
						signature,
					},
					"proposal submitted",
				);
			} catch (err) {
				logger.warn({ err, orderUid: order.uid }, "failed to submit proposal");
			}
		}
	};

	// --- Proposal state sync loop ---
	const syncProposals = async (): Promise<void> => {
		const nowSecs = BigInt(Math.floor(Date.now() / 1000));

		let active: ProposalMetadata[];
		try {
			active = await byos.proposals();
		} catch (err) {
			logger.warn({ err }, "failed to sync proposal state");
			return;
		}

		const activeIds = new Set(active.map((p) => p.id));

		for (const [uid, cached] of proposals) {
			if (cached.status === "active" && !activeIds.has(cached.proposalId)) {
				proposals.set(uid, { ...cached, status: "deactivated" });
				logger.info({ proposalId: cached.proposalId, orderUid: uid }, "proposal deactivated");
			}
			if (cached.status === "deactivated" && nowSecs > cached.validUntil) {
				proposals.delete(uid);
				logger.debug({ orderUid: uid }, "proposal dropped from cache");
			}
		}
	};

	logger.info({ subSolver: account.address }, "starting private MM subsolver");

	// Kick off both loops independently
	const scheduleLoop = (fn: () => Promise<void>, intervalMs: number): (() => void) => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			try {
				await fn();
			} catch (err) {
				logger.warn({ err }, "loop iteration failed");
			}
			timer = setTimeout(tick, intervalMs);
		};
		timer = setTimeout(tick, 0);
		return () => clearTimeout(timer);
	};

	const stopPoll = scheduleLoop(pollOrderbook, config.orderbookPollIntervalMs);
	const stopSync = scheduleLoop(syncProposals, config.proposalSyncIntervalMs);

	const shutdown = () => {
		logger.info("shutting down");
		stopPoll();
		stopSync();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
