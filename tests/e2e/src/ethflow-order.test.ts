/**
 * E2e test for native ETH sell orders placed via CoWSwapEthFlow.
 *
 * Diagnostic goal: reproduce the production bug where subsolvers submit a
 * proposal with sellToken = WETH for an EthFlow order and receive a
 * TokenMismatch rejection. The test also reveals what sellToken the CoW
 * orderbook actually returns for these orders, which is the missing piece
 * needed to understand and fix the bug.
 *
 * Requires the full e2e stack running (pnpm e2e:up), which deploys EthFlow
 * at 0xD02De8Da0B71E1B59489794F423FaBBa2AdC4d93 via 11-deploy-ethflow.ts.
 */
import { pad, parseEther, encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { deployerWallet, publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	depositToEscrow,
	ensureTrampolineDeployed,
	getAmountsOut,
} from "./helpers/orderbook.js";
import { mineBlock } from "./helpers/chain.js";
import type { Address } from "viem";

// ------------------------------------------------------------------
// EthFlow contract
// ------------------------------------------------------------------

// Must match ETHFLOW_CONTRACTS in offline-mode/.env — the address the driver/autopilot watch.
const ETHFLOW_ADDRESS = "0x04501b9b1d52e67f6862d157e00d13419d2d6e95" as Address;

/**
 * EthFlowOrder struct as expected by CoWSwapEthFlow.createOrder.
 * sellToken is always WETH (the contract wraps the sent ETH).
 * quoteId = -1 is the canonical "no quote" sentinel accepted by the contract.
 */
interface EthFlowOrderParams {
	buyToken: Address;
	receiver: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	appData: `0x${string}`;
	feeAmount: bigint;
	validTo: number;
	partiallyFillable: boolean;
	quoteId: bigint;
}

const ETHFLOW_CREATE_ORDER_ABI = [
	{
		type: "function",
		name: "createOrder",
		inputs: [
			{
				name: "order",
				type: "tuple",
				components: [
					{ name: "buyToken", type: "address" },
					{ name: "receiver", type: "address" },
					{ name: "sellAmount", type: "uint256" },
					{ name: "buyAmount", type: "uint256" },
					{ name: "appData", type: "bytes32" },
					{ name: "feeAmount", type: "uint256" },
					{ name: "validTo", type: "uint32" },
					{ name: "partiallyFillable", type: "bool" },
					{ name: "quoteId", type: "int64" },
				],
			},
		],
		outputs: [{ name: "orderHash", type: "bytes32" }],
		stateMutability: "payable",
	},
] as const;

/**
 * Create an EthFlow order by sending native ETH to the contract.
 * Returns the transaction hash.
 */
async function createEthFlowOrder(params: EthFlowOrderParams): Promise<`0x${string}`> {
	const hash = await traderWallet.sendTransaction({
		to: ETHFLOW_ADDRESS,
		data: encodeFunctionData({
			abi: ETHFLOW_CREATE_ORDER_ABI,
			functionName: "createOrder",
			args: [params],
		}),
		value: params.sellAmount + params.feeAmount,
	});
	await publicClient.waitForTransactionReceipt({ hash });
	return hash;
}

// ------------------------------------------------------------------
// Orderbook helpers
// ------------------------------------------------------------------

interface OrderbookOrder {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	status: string;
	signingScheme: string;
	owner: string;
}

/**
 * Poll GET /api/v1/account/{owner}/orders until a new order appears.
 * Returns the first order whose UID was not in `knownUids`.
 */
async function waitForNewOrder(
	ownerAddress: Address,
	knownUids: Set<string>,
	maxWaitMs = 30_000,
): Promise<OrderbookOrder> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const resp = await fetch(
			`${CONFIG.orderbookUrl}/api/v1/account/${ownerAddress}/orders`,
		);
		if (resp.ok) {
			const orders = (await resp.json()) as OrderbookOrder[];
			const newOrder = orders.find((o) => !knownUids.has(o.uid));
			if (newOrder) return newOrder;
		}
		await mineBlock(publicClient);
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`No new order appeared for ${ownerAddress} within ${maxWaitMs}ms`);
}

/**
 * Snapshot the current order UIDs for an owner so we can detect new ones later.
 */
async function snapshotOrderUids(ownerAddress: Address): Promise<Set<string>> {
	const resp = await fetch(
		`${CONFIG.orderbookUrl}/api/v1/account/${ownerAddress}/orders`,
	);
	if (!resp.ok) return new Set();
	const orders = (await resp.json()) as OrderbookOrder[];
	return new Set(orders.map((o) => o.uid));
}

// ------------------------------------------------------------------
// Test lifecycle
// ------------------------------------------------------------------

beforeAll(async () => {
	await depositToEscrow(
		subSolverWallet,
		publicClient,
		ACCOUNTS.subSolver.address,
		2_000_000_000_000_000_000n, // 2 ETH
	);
	await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);
});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("EthFlow native ETH sell order (COW-EthFlow)", () => {
	it(
		"accepts proposal with WETH sellToken for EthFlow order (no TokenMismatch)",
		{ timeout: 120_000 },
		async () => {
			const sellAmount = parseEther("0.1"); // 0.1 ETH

			// 1. Quote: how much USDC do we expect for 0.1 WETH via Uniswap
			const amounts = await getAmountsOut(publicClient, sellAmount, [
				CONTRACTS.weth,
				CONTRACTS.usdc,
			]);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const expectedBuyAmount = amounts[1]!;
			const minBuyAmount = (expectedBuyAmount * 95n) / 100n; // 5% slippage

			// 2. Snapshot existing EthFlow orders so we can detect the new one
			const knownUids = await snapshotOrderUids(ETHFLOW_ADDRESS);

			// 3. Create the EthFlow order — trader sends native ETH
			const validTo = Math.floor(Date.now() / 1000) + 600;
			await createEthFlowOrder({
				buyToken: CONTRACTS.usdc,
				receiver: ACCOUNTS.trader.address,
				sellAmount,
				buyAmount: minBuyAmount,
				appData: pad("0x00", { size: 32 }),
				feeAmount: 0n,
				validTo,
				partiallyFillable: false,
				quoteId: -1n,
			});

			// 4. Fetch the order from the CoW orderbook to inspect its sellToken
			const ethflowOrder = await waitForNewOrder(ETHFLOW_ADDRESS, knownUids);

			// ---------------------------------------------------------------
			// DIAGNOSTIC: log the actual sellToken so we can see what CoW
			// returns for EthFlow orders. This is the key unknown.
			// ---------------------------------------------------------------
			console.log("[ethflow] order uid:        ", ethflowOrder.uid);
			console.log("[ethflow] order sellToken:  ", ethflowOrder.sellToken);
			console.log("[ethflow] order buyToken:   ", ethflowOrder.buyToken);
			console.log("[ethflow] signingScheme:    ", ethflowOrder.signingScheme);
			console.log("[ethflow] owner:            ", ethflowOrder.owner);

			// 5. Subsolver submits a proposal using WETH as the sell token —
			//    which is what a correct subsolver would do to settle an ETH sell.
			const interactions = buildSellInteractions(
				CONTRACTS.weth,
				CONTRACTS.usdc,
				sellAmount,
				minBuyAmount,
			);

			const { id: proposalId } = await signAndSubmitProposal({
				walletClient: subSolverWallet,
				orderUid: ethflowOrder.uid,
				sellToken: CONTRACTS.weth,
				buyToken: CONTRACTS.usdc,
				sellAmount,
				minBuyAmount,
				quoteBuyAmount: expectedBuyAmount,
				interactions,
			});

			// 6. Wait for BYOS to process the proposal to a non-pending terminal state.
			// Valid statuses: active (validated), settled (full success), rejected,
			// simFailed, settleFailed. We accept any terminal outcome so we can
			// assert on the specific status rather than timing out.
			const proposal = await waitForProposalStatus(
				subSolverWallet,
				proposalId,
				["active", "settled", "rejected", "simFailed", "settleFailed"],
				60_000,
			);

			console.log("[ethflow] proposal status:         ", proposal.status);
			console.log("[ethflow] proposal rejectionReason:", proposal.rejectionReason);

			// The bug was: proposal rejected with TokenMismatch because the SDK
			// transformed sellToken to 0xEeeE... and validTo to userValidTo, causing
			// a hash mismatch in EthFlow.isValidSignature. After the fix, the proposal
			// should be active (validated) or settled (full end-to-end success).
			expect(["active", "settled"]).toContain(proposal.status);
		},
	);
});
