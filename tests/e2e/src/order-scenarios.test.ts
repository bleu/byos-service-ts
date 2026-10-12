/**
 * Parallel order scenario e2e tests.
 *
 * All scenarios post their orders/proposals concurrently (describe.concurrent)
 * to exercise the system under realistic load. Each scenario uses a dedicated
 * trader + sub-solver account pair to avoid UID/nonce collisions.
 *
 * Scenarios:
 *   1. Happy path       — valid order + valid proposal → fulfilled
 *   2. simFailed        — valid order + impossible interactions → simFailed/rejected
 *   3. Expired (late)   — valid order + proposal that expires before BYOS can use it
 *   4. Invalid order    — order with validTo in the past → HTTP 400 at submission
 *   5. Unprofitable     — proposal where limit price == market quote → zero surplus → Unprofitable
 *   6. SolverOutbid     — proposal submitted after the order was already settled on-chain
 *                         → simulation reverts "GPv2: order filled" → SolverOutbid
 *
 * Requires the full e2e stack running (pnpm e2e:up).
 */

import { type Address, createWalletClient, http, pad, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { anvilMainnet, deployerWallet, publicClient } from "./helpers/clients.js";
import { ACCOUNTS, CONFIG, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	type GpvOrder,
	getAmountsOut,
	signAndSubmitOrder,
	waitForOrderExecution,
} from "./helpers/orderbook.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SELL_TOKEN = CONTRACTS.usdc;
const BUY_TOKEN = CONTRACTS.weth;
const SELL_AMOUNT = 1_000_000_000n; // 1000 USDC (6 dec)
const FUND_AMOUNT = 3_000_000_000n; // 3000 USDC — enough for one order per trader
const ESCROW_DEPOSIT = 1_000_000_000_000_000_000n; // 1 ETH

// ── Per-scenario wallets ──────────────────────────────────────────────────────
//
// Fresh identities isolate these scenarios from persisted escrow cache entries.
function freshSubSolver() {
	const key = generatePrivateKey();
	return { key, address: privateKeyToAccount(key).address };
}
const subSolvers = {
	subSolver: freshSubSolver(),
	subSolver2: freshSubSolver(),
	subSolver3: freshSubSolver(),
	subSolver4: freshSubSolver(),
	subSolver5: freshSubSolver(),
	lateSubSolver: freshSubSolver(),
};

function makeWallet(key: `0x${string}`): WalletClient {
	return createWalletClient({
		account: privateKeyToAccount(key),
		chain: anvilMainnet,
		transport: http(CONFIG.rpcUrl),
	});
}

const wallets = {
	trader: makeWallet(ACCOUNTS.trader.key),
	subSolver: makeWallet(subSolvers.subSolver.key),
	trader2: makeWallet(ACCOUNTS.trader2.key),
	subSolver2: makeWallet(subSolvers.subSolver2.key),
	trader3: makeWallet(ACCOUNTS.trader3.key),
	subSolver3: makeWallet(subSolvers.subSolver3.key),
	trader4: makeWallet(ACCOUNTS.trader4.key),
	subSolver4: makeWallet(subSolvers.subSolver4.key),
	trader5: makeWallet(ACCOUNTS.trader5.key),
	subSolver5: makeWallet(subSolvers.subSolver5.key),
	lateSubSolver: makeWallet(subSolvers.lateSubSolver.key),
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
	// Anvil accounts #10+ are not pre-funded with ETH in the chain snapshot.
	// Set their balances directly so they can pay gas for approvals and order submissions.
	await Promise.all([
		publicClient.request({
			method: "anvil_setBalance" as "eth_chainId",
			params: [ACCOUNTS.trader4.address, "0x8AC7230489E80000"] as never, // 10 ETH
		}),
		publicClient.request({
			method: "anvil_setBalance" as "eth_chainId",
			params: [ACCOUNTS.trader5.address, "0x8AC7230489E80000"] as never, // 10 ETH
		}),
	]);

	// Serialize deployer transactions and fund every identity before its first API request.
	for (const subSolver of Object.values(subSolvers)) {
		await depositToEscrow(deployerWallet, publicClient, subSolver.address, ESCROW_DEPOSIT);
		await ensureTrampolineDeployed(deployerWallet, publicClient, subSolver.address);
	}
	await fundToken(deployerWallet, publicClient, SELL_TOKEN, ACCOUNTS.trader.address, FUND_AMOUNT);
	await fundToken(deployerWallet, publicClient, SELL_TOKEN, ACCOUNTS.trader2.address, FUND_AMOUNT);
	await fundToken(deployerWallet, publicClient, SELL_TOKEN, ACCOUNTS.trader3.address, FUND_AMOUNT);
	await fundToken(deployerWallet, publicClient, SELL_TOKEN, ACCOUNTS.trader4.address, FUND_AMOUNT);
	await fundToken(deployerWallet, publicClient, SELL_TOKEN, ACCOUNTS.trader5.address, FUND_AMOUNT);

	// Approvals: each from a different trader wallet — safe in parallel.
	await Promise.all([
		approveVaultRelayer(wallets.trader, publicClient, SELL_TOKEN),
		approveVaultRelayer(wallets.trader2, publicClient, SELL_TOKEN),
		approveVaultRelayer(wallets.trader3, publicClient, SELL_TOKEN),
		approveVaultRelayer(wallets.trader4, publicClient, SELL_TOKEN),
		approveVaultRelayer(wallets.trader5, publicClient, SELL_TOKEN),
	]);
}, 180_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOrder(receiver: Address, validToOffset = 600): GpvOrder {
	return {
		sellToken: SELL_TOKEN,
		buyToken: BUY_TOKEN,
		receiver,
		sellAmount: SELL_AMOUNT,
		buyAmount: 1n, // any amount satisfies the trader; actual price enforced by proposal
		validTo: Math.floor(Date.now() / 1000) + validToOffset,
		appData: pad("0x00", { size: 32 }),
		feeAmount: 0n,
		kind: "sell",
		partiallyFillable: false,
		sellTokenBalance: "erc20",
		buyTokenBalance: "erc20",
	};
}

async function getQuoteAmounts() {
	const amounts = await getAmountsOut(publicClient, SELL_AMOUNT, [SELL_TOKEN, BUY_TOKEN]);
	const quoteBuyAmount = amounts[1];
	if (quoteBuyAmount === undefined) throw new Error("getAmountsOut returned no output amount");
	const minBuyAmount = (quoteBuyAmount * 9990n) / 10000n; // 0.1% slippage — within the 100 bps e2e limit
	return { quoteBuyAmount, minBuyAmount };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.concurrent("order scenarios", () => {
	it("happy path: valid order + proposal should be fulfilled", async () => {
		const order = buildOrder(ACCOUNTS.trader.address);
		const orderUid = await signAndSubmitOrder(wallets.trader, order);

		const { quoteBuyAmount, minBuyAmount } = await getQuoteAmounts();
		const interactions = buildSellInteractions(SELL_TOKEN, BUY_TOKEN, SELL_AMOUNT, minBuyAmount);

		await signAndSubmitProposal({
			walletClient: wallets.subSolver,
			orderUid,
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount,
			quoteBuyAmount,
			interactions,
		});

		await waitForOrderExecution(orderUid, publicClient, 120_000);
	});

	it("simFailed: proposal with impossible swap output should fail simulation", async () => {
		const order = buildOrder(ACCOUNTS.trader2.address);
		const orderUid = await signAndSubmitOrder(wallets.trader2, order);

		const { quoteBuyAmount, minBuyAmount } = await getQuoteAmounts();

		// Demand 1000× the real output — the Uniswap swap will revert during simulation
		const badInteractions = buildSellInteractions(
			SELL_TOKEN,
			BUY_TOKEN,
			SELL_AMOUNT,
			quoteBuyAmount * 1000n,
		);

		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: wallets.subSolver2,
			orderUid,
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount,
			quoteBuyAmount,
			interactions: badInteractions,
		});

		const proposal = await waitForProposalStatus(
			wallets.subSolver2,
			proposalId,
			["simFailed", "rejected"],
			60_000,
		);
		expect(["simFailed", "rejected"]).toContain(proposal.status);
	});

	it("expired: proposal with a short validUntil should expire before being used", async () => {
		const order = buildOrder(ACCOUNTS.trader3.address);
		const orderUid = await signAndSubmitOrder(wallets.trader3, order);

		const { quoteBuyAmount, minBuyAmount } = await getQuoteAmounts();
		const interactions = buildSellInteractions(SELL_TOKEN, BUY_TOKEN, SELL_AMOUNT, minBuyAmount);

		// validUntilOffset: 3 — proposal expires 3 seconds from now
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: wallets.subSolver3,
			orderUid,
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount,
			quoteBuyAmount,
			interactions,
			validUntilOffset: 3,
		});

		const proposal = await waitForProposalStatus(
			wallets.subSolver3,
			proposalId,
			["expired", "rejected"],
			60_000,
		);
		expect(["expired", "rejected"]).toContain(proposal.status);
	});

	it("invalid order: validTo in the past should be rejected at submission", async () => {
		const order = buildOrder(ACCOUNTS.trader.address, -60); // validTo 60s in the past

		const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...order,
				sellAmount: order.sellAmount.toString(),
				buyAmount: order.buyAmount.toString(),
				feeAmount: order.feeAmount.toString(),
				from: ACCOUNTS.trader.address,
				signature: pad("0x00", { size: 65 }),
				signingScheme: "eip712",
			}),
		});

		expect(resp.ok).toBe(false);
		expect(resp.status).toBe(400);
	});

	it("unprofitable: proposal where limit price equals market quote should be rejected as Unprofitable", async () => {
		const { quoteBuyAmount } = await getQuoteAmounts();

		// Set the order's limit price to the exact market quote.
		// After simulation, surplus = simulationBuyAmount − orderBuyAmount ≈ 0,
		// so score = surplusEth − gasCost < 0 → Unprofitable.
		const order = { ...buildOrder(ACCOUNTS.trader4.address), buyAmount: quoteBuyAmount };
		const orderUid = await signAndSubmitOrder(wallets.trader4, order);

		// Zero gap between min and quote: passes slippage check (gap = 0),
		// but leaves no room for surplus above the order limit after gas.
		const interactions = buildSellInteractions(SELL_TOKEN, BUY_TOKEN, SELL_AMOUNT, quoteBuyAmount);
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: wallets.subSolver4,
			orderUid,
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount: quoteBuyAmount, // must be ≥ orderBuyAmount to pass envelope check
			quoteBuyAmount,
			interactions,
		});

		const proposal = await waitForProposalStatus(
			wallets.subSolver4,
			proposalId,
			["rejected"],
			60_000,
		);
		expect(proposal.status).toBe("rejected");
		expect(proposal.rejectionReason).toBe("Unprofitable");
	}, 60_000);

	it("solverOutbid: proposal submitted after on-chain settlement should be rejected as SolverOutbid", async () => {
		// Phase 1: Submit order + proposal and let BYOS settle it on-chain.
		const order = buildOrder(ACCOUNTS.trader5.address);
		const orderUid = await signAndSubmitOrder(wallets.trader5, order);

		const { quoteBuyAmount, minBuyAmount } = await getQuoteAmounts();
		const interactions = buildSellInteractions(SELL_TOKEN, BUY_TOKEN, SELL_AMOUNT, minBuyAmount);

		await signAndSubmitProposal({
			walletClient: wallets.subSolver5,
			orderUid,
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount,
			quoteBuyAmount,
			interactions,
		});

		// Wait for the order to be fully settled on-chain.
		await waitForOrderExecution(orderUid, publicClient, 120_000);

		// Phase 2: Submit a late proposal for the same (now-filled) order.
		// The BYOS validator will simulate it and get "GPv2: order filled",
		// which is promoted to rejected/SolverOutbid.
		const { id: lateProposalId } = await signAndSubmitProposal({
			walletClient: wallets.lateSubSolver, // separate identity for the late proposal
			orderUid, // same filled order
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount,
			quoteBuyAmount,
			interactions,
		});

		const lateProposal = await waitForProposalStatus(
			wallets.lateSubSolver,
			lateProposalId,
			["rejected"],
			60_000,
		);
		expect(lateProposal.status).toBe("rejected");
		expect(lateProposal.rejectionReason).toBe("SolverOutbid");
	}, 180_000);
});
