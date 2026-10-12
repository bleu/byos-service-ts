/**
 * Settlement correctness under a burst: every order fills on-chain and BYOS records success.
 * Run pnpm test:e2e:settlement with the full stack running.
 * Activation throughput is measured separately with auctions paused.
 */

import { TrampolineAbi } from "@byos/common";
import {
	type Address,
	createWalletClient,
	type Hex,
	http,
	keccak256,
	pad,
	parseEventLogs,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
	cancelAllActiveProposals,
	cancelProposals,
	collectSubmissions,
	signAndSubmitProposal,
	waitForProposalStatus,
} from "./helpers/byos.js";
import { anvilMainnet, deployerWallet, publicClient } from "./helpers/clients.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	approveVaultRelayer,
	cancelOrders,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	getAmountsOut,
	signAndSubmitOrder,
} from "./helpers/orderbook.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const N = 70;
const EXCLUSIVE_PER_SUB_SOLVER = 30;
const SETTLE_TIMEOUT = 60_000;
const submittedOrders: string[] = [];
const submittedProposals: number[][] = [[], []];
const trampolines: Address[] = [];

const SELL_TOKEN = CONTRACTS.usdc;
const BUY_TOKEN = CONTRACTS.weth;
const SELL_AMOUNT = 10_000_000n; // 10 USDC (6 dec)
const FUND_AMOUNT = SELL_AMOUNT * BigInt(N) * 2n; // 2× headroom
const ESCROW_DEPOSIT = 2_000_000_000_000_000_000n; // 2 ETH

// ── Wallets ───────────────────────────────────────────────────────────────────

function makeWallet(key: `0x${string}`): WalletClient {
	return createWalletClient({
		account: privateKeyToAccount(key),
		chain: anvilMainnet,
		transport: http(CONFIG.rpcUrl),
	});
}

const wallets = {
	trader: makeWallet(ACCOUNTS.trader.key),
	subSolver: makeWallet(ACCOUNTS.subSolver.key),
	subSolver2: makeWallet(ACCOUNTS.subSolver2.key),
};

// ── Setup ─────────────────────────────────────────────────────────────────────
//
// Deploy Trampolines sequentially through the deployer to preserve its nonce sequence.
const subSolvers = [
	{ wallet: wallets.subSolver, address: ACCOUNTS.subSolver.address },
	{ wallet: wallets.subSolver2, address: ACCOUNTS.subSolver2.address },
];

beforeAll(async () => {
	await Promise.all([
		...subSolvers.map(async ({ wallet, address }) => {
			await cancelAllActiveProposals(wallet);
			await depositToEscrow(wallet, publicClient, address, ESCROW_DEPOSIT);
		}),
		approveVaultRelayer(wallets.trader, publicClient, SELL_TOKEN),
		(async () => {
			for (const { address } of subSolvers)
				trampolines.push(await ensureTrampolineDeployed(deployerWallet, publicClient, address));
			await fundToken(
				deployerWallet,
				publicClient,
				SELL_TOKEN,
				ACCOUNTS.trader.address,
				FUND_AMOUNT,
			);
		})(),
	]);
}, 60_000);

afterEach(async () => {
	await cancelOrders(wallets.trader, submittedOrders);
	await Promise.all(
		subSolvers.map(({ wallet }, index) => cancelProposals(wallet, submittedProposals[index] ?? [])),
	);
}, 60_000);

// ── Test ──────────────────────────────────────────────────────────────────────

it(`all ${N} concurrent orders execute in same-sub-solver batches with overlapping proposals`, {
	timeout: SETTLE_TIMEOUT + 120_000,
}, async () => {
	// 1. Quote — read-only, instant.
	const amounts = await getAmountsOut(publicClient, SELL_AMOUNT, [SELL_TOKEN, BUY_TOKEN]);
	const quoteBuyAmount = amounts[1];
	if (quoteBuyAmount === undefined) throw new Error("missing quote buy amount");
	const minBuyAmount = (quoteBuyAmount * 9990n) / 10000n; // Floor leaves room for the competing quote.

	// 2. Submit N orders in parallel.
	//    Each gets a unique validTo so the GPv2 UID is distinct (no on-chain nonce needed).
	const baseValidTo = Math.floor(Date.now() / 1000) + 600;
	const orderUids = await collectSubmissions(
		Array.from({ length: N }, (_, i) =>
			signAndSubmitOrder(wallets.trader, {
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				receiver: ACCOUNTS.trader.address as Address,
				sellAmount: SELL_AMOUNT,
				buyAmount: 1n,
				validTo: baseValidTo + i,
				appData: pad("0x00", { size: 32 }),
				feeAmount: 0n,
				kind: "sell",
				partiallyFillable: false,
				sellTokenBalance: "erc20",
				buyTokenBalance: "erc20",
			}),
		),
		(uid) => submittedOrders.push(uid),
	);

	// 30 exclusive orders per sub-solver; ten overlapping orders alternate the better quote.
	const assignments = orderUids.flatMap((orderUid, orderIndex) => {
		const winner =
			orderIndex < EXCLUSIVE_PER_SUB_SOLVER
				? 0
				: orderIndex < 2 * EXCLUSIVE_PER_SUB_SOLVER
					? 1
					: (orderIndex - 2 * EXCLUSIVE_PER_SUB_SOLVER) % 2;
		const owners = orderIndex < 2 * EXCLUSIVE_PER_SUB_SOLVER ? [winner] : [0, 1];
		return owners.map((subSolverIndex) => ({
			orderUid,
			subSolverIndex,
			winner: subSolverIndex === winner,
		}));
	});
	const interactions = buildSellInteractions(SELL_TOKEN, BUY_TOKEN, SELL_AMOUNT, minBuyAmount);
	const nonceBase = BigInt(Date.now()) * 1000n;
	const proposalResults = await collectSubmissions(
		assignments.map(async (assignment, index) => {
			const subSolver = subSolvers[assignment.subSolverIndex];
			if (!subSolver) throw new Error("missing sub-solver");
			const { id } = await signAndSubmitProposal({
				walletClient: subSolver.wallet,
				orderUid: assignment.orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: SELL_AMOUNT,
				minBuyAmount,
				quoteBuyAmount: assignment.winner ? quoteBuyAmount : (quoteBuyAmount * 9995n) / 10000n,
				interactions,
				nonce: nonceBase + BigInt(index),
				validUntilOffset: 600,
			});
			return { id, ...assignment };
		}),
		({ id, subSolverIndex }) => submittedProposals[subSolverIndex]?.push(id),
	);
	expect(proposalResults).toHaveLength(80);

	// 4. Wait for all N on-chain settlements.
	//    Do NOT call mineBlock here — Anvil's --block-time 2 auto-mines every 2 s.
	//    Manual mineBlock calls race with the driver's tx submission: if the block is
	//    mined before the pending tx lands in Anvil's mempool, the driver re-simulates
	//    at "pending" state (which already includes the tx it just submitted), sees
	//    "order filled", and cancels its own settlement. Pure polling avoids this race.

	const settleDeadline = Date.now() + SETTLE_TIMEOUT;
	const fulfilled = new Set<string>();

	while (fulfilled.size < orderUids.length) {
		if (Date.now() > settleDeadline) {
			throw new Error(
				`${orderUids.length - fulfilled.size} of ${orderUids.length} orders not fulfilled within ${SETTLE_TIMEOUT}ms`,
			);
		}

		await new Promise((r) => setTimeout(r, 2_000));

		await Promise.all(
			orderUids
				.filter((uid) => !fulfilled.has(uid))
				.map(async (uid) => {
					const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders/${uid}`);
					if (!resp.ok) return;
					const data = (await resp.json()) as { status: string };
					if (data.status === "fulfilled") fulfilled.add(uid);
					else if (data.status === "expired" || data.status === "cancelled") {
						throw new Error(`Order ${data.status}: ${uid}`);
					}
				}),
		);
	}

	for (const uid of orderUids) {
		const filled = await publicClient.readContract({
			address: CONTRACTS.gpv2Settlement,
			abi: [
				{
					type: "function",
					name: "filledAmount",
					inputs: [{ name: "orderUid", type: "bytes" }],
					outputs: [{ type: "uint256" }],
					stateMutability: "view",
				},
			],
			functionName: "filledAmount",
			args: [uid as Hex],
		});
		expect(filled, `on-chain fill for ${uid}`).toBe(SELL_AMOUNT);
	}
	expect(fulfilled.size).toBe(orderUids.length);
	const transactions = new Map<Hex, { subSolverIndex: number; orderHashes: Set<string> }>();
	await Promise.all(
		proposalResults.map(async ({ id, subSolverIndex, orderUid, winner }) => {
			const subSolver = subSolvers[subSolverIndex];
			if (!subSolver) throw new Error("missing sub-solver");
			const proposal = await waitForProposalStatus(
				subSolver.wallet,
				id,
				winner ? ["settled"] : ["rejected"],
				30_000,
			);
			if (!winner) {
				expect(proposal.rejectionReason, `losing proposal ${id}`).toBe("SubsolverOutbid");
				return;
			}
			const txHash = proposal.settlementTxHash as Hex;
			expect(txHash, `settlement for proposal ${id}`).toMatch(/^0x[0-9a-f]{64}$/i);
			const transaction = transactions.get(txHash);
			if (transaction) {
				expect(transaction.subSolverIndex, `mixed sub-solvers in ${txHash}`).toBe(subSolverIndex);
				transaction.orderHashes.add(keccak256(orderUid as Hex));
			} else
				transactions.set(txHash, {
					subSolverIndex,
					orderHashes: new Set([keccak256(orderUid as Hex)]),
				});
		}),
	);
	const batchedSubSolvers = new Set<number>();
	for (const [hash, { subSolverIndex, orderHashes }] of transactions) {
		const receipt = await publicClient.getTransactionReceipt({ hash });
		expect(receipt.status).toBe("success");
		const executions = parseEventLogs({
			abi: TrampolineAbi,
			eventName: "Executed",
			logs: receipt.logs,
		});
		expect(new Set(executions.map((event) => event.address.toLowerCase()))).toEqual(
			new Set([trampolines[subSolverIndex]?.toLowerCase()]),
		);
		expect(new Set(executions.map((event) => event.args._orderUidHash))).toEqual(orderHashes);
		expect(executions).toHaveLength(orderHashes.size);
		if (orderHashes.size > 1) batchedSubSolvers.add(subSolverIndex);
	}
	expect(batchedSubSolvers).toEqual(new Set([0, 1]));
	console.info(
		"Settlement batches",
		[...transactions].map(([txHash, batch]) => ({
			txHash,
			subSolver: subSolvers[batch.subSolverIndex]?.address,
			orders: batch.orderHashes.size,
		})),
	);
});
