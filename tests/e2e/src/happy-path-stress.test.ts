import { TrampolineFactoryAbi } from "@byos/common";
import { E2E_FIXTURES } from "./helpers/fixtures.js";
import { assertE2ePrerequisites } from "./helpers/prerequisites.js";
import { createTimingLog } from "./helpers/timing.js";
/**
 * Settlement correctness under a burst: every order fills on-chain and BYOS records success.
 * Run pnpm test:e2e with the full stack running.
 * Use E2E_STRESS_ORDERS to choose the burst size (default 70).
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
	collectSubmissions,
	submitProposalBurstUntilSettled,
	waitForProposalStatus,
} from "./helpers/byos.js";
import { anvilMainnet, publicClient } from "./helpers/clients.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import { cancelOrders, getAmountsOut, signAndSubmitOrder } from "./helpers/orderbook.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const N = Number(process.env.E2E_STRESS_ORDERS ?? 70);
if (!Number.isInteger(N) || N < 6) throw new Error("E2E_STRESS_ORDERS must be an integer >= 6");
const EXCLUSIVE_PER_SUB_SOLVER = Math.floor((N * 3) / 7);
const SETTLE_TIMEOUT = N * 8_000 + 30_000;
const submittedOrders: string[] = [];
const trampolines: Address[] = [];

const SELL_TOKEN = CONTRACTS.usdc;
const BUY_TOKEN = CONTRACTS.weth;
const SELL_AMOUNT = 10_000_000n; // 10 USDC (6 dec)

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
// Trampolines and collateral are seeded by e2e:up.
const subSolvers = [
	{ wallet: wallets.subSolver, address: ACCOUNTS.subSolver.address },
	{ wallet: wallets.subSolver2, address: ACCOUNTS.subSolver2.address },
];

beforeAll(async () => {
	const timing = createTimingLog("stress setup");
	await Promise.all([
		assertE2ePrerequisites(E2E_FIXTURES.standard),
		assertE2ePrerequisites(E2E_FIXTURES.stress),
	]);
	for (const { wallet, address } of subSolvers) {
		await cancelAllActiveProposals(wallet);
		trampolines.push(
			await publicClient.readContract({
				address: CONTRACTS.trampolineFactory,
				abi: TrampolineFactoryAbi,
				functionName: "addressOf",
				args: [address],
			}),
		);
	}
	timing("seeded stress accounts verified; stale proposals cancelled");
}, 60_000);

afterEach(async () => {
	const timing = createTimingLog("stress cleanup");
	await cancelOrders(wallets.trader, submittedOrders);
	timing("orders and proposals cleaned up");
}, 60_000);

// ── Test ──────────────────────────────────────────────────────────────────────

it(`all ${N} concurrent orders settle with overlapping sub-solver proposals`, {
	timeout: SETTLE_TIMEOUT + 120_000,
}, async () => {
	const timing = createTimingLog(`stress ${N} orders`);
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

	timing("quote fetched and concurrent orders accepted");

	// Exclusive orders plus overlapping orders that alternate the better quote.
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
	const proposalResults = await submitProposalBurstUntilSettled(
		assignments.map((assignment) => {
			const subSolver = subSolvers[assignment.subSolverIndex];
			if (!subSolver) throw new Error("missing sub-solver");
			return {
				...assignment,
				params: {
					walletClient: subSolver.wallet,
					orderUid: assignment.orderUid,
					sellToken: SELL_TOKEN,
					buyToken: BUY_TOKEN,
					sellAmount: SELL_AMOUNT,
					minBuyAmount,
					quoteBuyAmount: assignment.winner ? quoteBuyAmount : (quoteBuyAmount * 9995n) / 10000n,
					interactions,
					validUntilOffset: 300,
				},
			};
		}),
		SETTLE_TIMEOUT,
		timing,
	);
	expect(proposalResults).toHaveLength(N);

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
	timing("all on-chain filled amounts verified");
	const transactions = new Map<Hex, { subSolverIndex: number; orderHashes: Set<string> }>();
	await Promise.all(
		proposalResults.map(async ({ id, subSolverIndex, params: { orderUid } }) => {
			const subSolver = subSolvers[subSolverIndex];
			if (!subSolver) throw new Error("missing sub-solver");
			const proposal = await waitForProposalStatus(subSolver.wallet, id, ["settled"], 30_000);
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
	}
	timing("settlement receipts and sub-solver attribution verified");
	console.info(
		"Settlement batches",
		[...transactions].map(([txHash, batch]) => ({
			txHash,
			subSolver: subSolvers[batch.subSolverIndex]?.address,
			orders: batch.orderHashes.size,
		})),
	);
});
