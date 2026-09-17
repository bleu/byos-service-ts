import "dotenv/config";
import type { ContractInteraction } from "@byos/common";
import { byosDomain, Erc20Abi, signProposal, TrampolineFactoryAbi } from "@byos/common";
import type { OrderbookOrder, ProposalMetadata } from "@byos/subsolver-core";
import { ByosClient, OrderbookClient, randomNonce } from "@byos/subsolver-core";
import pino from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, encodeFunctionData, http, keccak256 } from "viem";
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
	buyToken: string; // lowercased — needed to un-reserve on deactivation
	sellAmount: bigint; // amount reserved in reservedBalance
}

async function main() {
	const config = parseConfig();

	const logger = pino({
		level: config.logLevel,
		...(config.logPretty ? { transport: { target: "pino-pretty" } } : {}),
	});

	// BYOS rejects proposals with validUntil more than MAX_PROPOSAL_LIFETIME_SECS
	// (default 300s) in the future (ADR-0013). Warn early so misconfiguration
	// doesn't cause every submission to be silently rejected at ingestion.
	const BYOS_DEFAULT_MAX_LIFETIME_SECS = 300n;
	if (config.maxProposalLifetimeSecs > BYOS_DEFAULT_MAX_LIFETIME_SECS) {
		logger.warn(
			{
				maxProposalLifetimeSecs: config.maxProposalLifetimeSecs.toString(),
				byosDefaultCap: BYOS_DEFAULT_MAX_LIFETIME_SECS.toString(),
			},
			"MAX_PROPOSAL_LIFETIME_MS exceeds BYOS default cap — proposals will be rejected at ingestion unless BYOS is configured with a higher MAX_PROPOSAL_LIFETIME_SECS",
		);
	}

	const account = privateKeyToAccount(config.privateKey);
	// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
	const signFn = (params: any) => account.signTypedData(params);

	const transport = http(config.rpcUrl);
	const publicClient = createPublicClient({ transport });

	// Resolve the trampoline address for this subsolver account once at startup
	const trampolineAddress = await publicClient.readContract({
		address: config.trampolineFactory,
		abi: TrampolineFactoryAbi,
		functionName: "addressOf",
		args: [account.address],
	});
	logger.info({ trampolineAddress, subSolver: account.address }, "resolved trampoline");

	// Reads the on-chain ERC20 balance of the trampoline for a given token
	const fetchOnChainBalance = (token: Address): Promise<bigint> =>
		publicClient.readContract({
			address: token,
			abi: Erc20Abi,
			functionName: "balanceOf",
			args: [trampolineAddress],
		});

	// Read both token balances at startup in a single multicall.
	// multicallAddress is required because the client has no chain definition — Multicall3
	// is deployed at this address on all major EVM chains.
	const [usdcBalance, usdtBalance] = await publicClient.multicall({
		allowFailure: false,
		multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
		contracts: [
			{
				address: config.usdcAddress,
				abi: Erc20Abi,
				functionName: "balanceOf",
				args: [trampolineAddress],
			},
			{
				address: config.usdtAddress,
				abi: Erc20Abi,
				functionName: "balanceOf",
				args: [trampolineAddress],
			},
		],
	});
	const availableBalance = new Map<string, bigint>([
		[config.usdcAddress.toLowerCase(), usdcBalance],
		[config.usdtAddress.toLowerCase(), usdtBalance],
	]);
	logger.info(
		{
			usdc: availableBalance.get(config.usdcAddress.toLowerCase())?.toString(),
			usdt: availableBalance.get(config.usdtAddress.toLowerCase())?.toString(),
		},
		"initial trampoline balances",
	);

	// Tracks amounts locked in active proposals (not yet settled/deactivated)
	const reservedBalance = new Map<string, bigint>([
		[config.usdcAddress.toLowerCase(), 0n],
		[config.usdtAddress.toLowerCase(), 0n],
	]);

	const netAvailable = (token: string): bigint =>
		(availableBalance.get(token) ?? 0n) - (reservedBalance.get(token) ?? 0n);

	const domain = byosDomain(config.chainId, config.trampolineFactory);
	const orderbook = new OrderbookClient(config.orderbookUrl);
	const byos = new ByosClient(config.byosUrl, domain, signFn);

	// Keyed by orderUid.toLowerCase()
	const proposals = new Map<string, CachedProposal>();

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

		// Filter uses in-memory net available — no RPC per poll
		const candidates = filterCandidates(orders, {
			usdcAddress: config.usdcAddress,
			usdtAddress: config.usdtAddress,
			trampolineBalance: new Map([
				[config.usdcAddress.toLowerCase(), netAvailable(config.usdcAddress.toLowerCase())],
				[config.usdtAddress.toLowerCase(), netAvailable(config.usdtAddress.toLowerCase())],
			]),
			trackedUids: new Set(proposals.keys()),
		});

		logger.info({ total: orders.length, candidates: candidates.length }, "orderbook fetched");

		for (const order of candidates) {
			const buy = order.buyToken.toLowerCase();
			const validUntil = nowSecs + config.maxProposalLifetimeSecs;

			// Re-read on-chain balance for the token we must deliver before committing
			let freshBalance: bigint;
			try {
				freshBalance = await fetchOnChainBalance(order.buyToken);
			} catch (err) {
				logger.warn({ err, orderUid: order.uid }, "failed to read on-chain balance, skipping");
				continue;
			}
			availableBalance.set(buy, freshBalance);

			const deliveryAmount = order.sellAmount + config.forcedSurplus;

			const net = netAvailable(buy);
			if (deliveryAmount > net) {
				logger.warn(
					{ orderUid: order.uid, net: net.toString(), required: deliveryAmount.toString() },
					"insufficient balance after RPC re-read, skipping",
				);
				continue;
			}

			// Reserve the delivery amount (including bonus) optimistically before submitting
			reservedBalance.set(buy, (reservedBalance.get(buy) ?? 0n) + deliveryAmount);

			const interactions: ContractInteraction[] = [
				{
					target: order.buyToken,
					value: 0n,
					callData: encodeFunctionData({
						abi: erc20TransferAbi,
						functionName: "transfer",
						args: [config.settlementAddress, deliveryAmount],
					}) as Hex,
				},
			];

			const proposal = {
				orderUidHash: keccak256(order.uid),
				sellToken: order.sellToken,
				buyToken: order.buyToken,
				sellAmount: order.sellAmount,
				minBuyAmount: deliveryAmount,
				quoteBuyAmount: deliveryAmount,
				validUntil,
				nonce: randomNonce(),
			};

			let signature: Hex;
			try {
				signature = await signProposal(signFn, domain, proposal, interactions);
			} catch (err) {
				reservedBalance.set(buy, (reservedBalance.get(buy) ?? 0n) - deliveryAmount);
				logger.warn({ err, orderUid: order.uid }, "failed to sign proposal, releasing reservation");
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
				proposals.set(order.uid.toLowerCase(), {
					proposalId: id,
					validUntil,
					status: "active",
					buyToken: buy,
					sellAmount: deliveryAmount,
				});
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
				reservedBalance.set(buy, (reservedBalance.get(buy) ?? 0n) - deliveryAmount);
				logger.warn(
					{ err, orderUid: order.uid },
					"failed to submit proposal, releasing reservation",
				);
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
				reservedBalance.set(
					cached.buyToken,
					(reservedBalance.get(cached.buyToken) ?? 0n) - cached.sellAmount,
				);
				logger.info(
					{ proposalId: cached.proposalId, orderUid: uid },
					"proposal deactivated, reservation released",
				);
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
