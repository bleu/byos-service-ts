/**
 * Happy-path full-stack e2e test.
 *
 * Exercises the core round-trip: place a GPv2 order on the orderbook,
 * submit a BYOS proposal with Uniswap V2 interactions, wait for the
 * autopilot → driver → /solve → settlement → /notify cycle to complete.
 *
 * Requires the full e2e stack running (./scripts/e2e-stack.sh up -d --build --wait).
 */
import type { Hex } from "viem";
import { pad } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
import { revertSnapshot, takeSnapshot } from "./helpers/chain.js";
import { deployerWallet, publicClient, subSolverWallet, traderWallet } from "./helpers/clients.js";
import { ACCOUNTS, CONTRACTS } from "./helpers/config.js";
import { buildSellInteractions } from "./helpers/interactions.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
	type GpvOrder,
	getAmountsOut,
	signAndSubmitOrder,
	tokenBalance,
	waitForOrderExecution,
} from "./helpers/orderbook.js";

// --- Test lifecycle ---

let snapshotId: Hex;

beforeAll(async () => {
	snapshotId = await takeSnapshot(publicClient);
});

afterAll(async () => {
	await revertSnapshot(publicClient, snapshotId);
});

// --- Tests ---

describe("happy path", () => {
	it("sell order: USDC → WETH settles end-to-end", async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const sellAmount = 1_000_000_000n; // 1000 USDC (6 decimals)

		// 1. Setup sub-solver: deposit to Escrow + deploy Trampoline
		// Must happen BEFORE proposal submission — the validator processes
		// proposals within 12s and marks them simFailed if escrow or trampoline
		// are missing.
		await depositToEscrow(
			subSolverWallet,
			publicClient,
			ACCOUNTS.subSolver.address,
			1_000_000_000_000_000_000n, // 1 ETH
		);
		await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);

		// 2. Fund trader with USDC and approve VaultRelayer
		await fundToken(
			deployerWallet,
			publicClient,
			sellToken,
			ACCOUNTS.trader.address,
			sellAmount * 3n,
		);
		await approveVaultRelayer(traderWallet, publicClient, sellToken);

		// 3. Get Uniswap V2 quote
		const amounts = await getAmountsOut(publicClient, sellAmount, [sellToken, buyToken]);
		const expectedBuyAmount = amounts[1];
		// 5% slippage tolerance
		const minBuyAmount = (expectedBuyAmount * 95n) / 100n;

		// 4. Sign and submit GPv2 order to the orderbook
		const validTo = Math.floor(Date.now() / 1000) + 600; // 10 min
		const order: GpvOrder = {
			sellToken,
			buyToken,
			receiver: ACCOUNTS.trader.address,
			sellAmount,
			buyAmount: minBuyAmount,
			validTo,
			appData: pad("0x00", { size: 32 }),
			feeAmount: 0n,
			kind: "sell",
			partiallyFillable: false,
			sellTokenBalance: "erc20",
			buyTokenBalance: "erc20",
		};

		const orderUid = await signAndSubmitOrder(traderWallet, order);
		expect(orderUid).toBeDefined();
		expect(orderUid.length).toBeGreaterThan(10);

		// 5. Submit BYOS proposal (Uniswap V2 sell swap)
		const interactions = buildSellInteractions(sellToken, buyToken, sellAmount, minBuyAmount);

		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellToken,
			buyToken,
			sellAmount,
			minBuyAmount,
			quoteBuyAmount: expectedBuyAmount,
			interactions,
		});
		expect(proposalId).toBeGreaterThan(0);

		// 6. Wait for the order to be fulfilled via the autopilot → driver → settlement cycle
		const result = await waitForOrderExecution(orderUid, publicClient);
		expect(result.status).toBe("fulfilled");

		// 7. Verify trader received WETH
		const wethBalance = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		expect(wethBalance).toBeGreaterThan(0n);

		// 8. Verify proposal reached settled status
		const proposal = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(proposal.status).toBe("settled");
	});
});
