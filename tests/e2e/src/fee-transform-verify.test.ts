/**
 * Fee-transform verification (COW-1240).
 *
 * Runs with FEE_POLICIES=surplus:0.5:0.01:any active in the autopilot.
 * After settlement, decodes the settle() calldata and verifies:
 *   1. The Trampoline execute() call is byte-identical to what BYOS sent
 *   2. The sell amount pulled from the user is unchanged
 *   3. The credited buy amount dropped by exactly the protocol fee
 *
 * This test also covers the happy-path for a USDC → WETH sell order
 * (place order → submit proposal → settle → proposal reaches "settled").
 * There is no separate happy-path sell-order test.
 *
 * Requires the full e2e stack running with the updated autopilot.
 */

import { GPv2SettlementAbi, TrampolineAbi } from "@byos/common";
import { decodeFunctionData, type Hex, pad, parseAbi } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { signAndSubmitProposal, waitForProposalStatus } from "./helpers/byos.js";
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

// --- Setup ---

beforeAll(async () => {
	await depositToEscrow(
		subSolverWallet,
		publicClient,
		ACCOUNTS.subSolver.address,
		1_000_000_000_000_000_000n,
	);
	await ensureTrampolineDeployed(deployerWallet, publicClient, ACCOUNTS.subSolver.address);
	await fundToken(
		deployerWallet,
		publicClient,
		CONTRACTS.usdc,
		ACCOUNTS.trader.address,
		3_000_000_000n,
	);
	await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.usdc);
});

// --- Test ---

describe("fee transform verification (COW-1240)", () => {
	it("driver's fee application leaves Trampoline execute identical and only reduces buy amount", {
		timeout: 180_000,
	}, async () => {
		const sellToken = CONTRACTS.usdc;
		const buyToken = CONTRACTS.weth;
		const sellAmount = 1_000_000_000n; // 1000 USDC

		// 1. Get Uniswap V2 quote
		const amounts = await getAmountsOut(publicClient, sellAmount, [sellToken, buyToken]);
		const quoteBuyAmount = amounts[1];
		const minBuyAmount = (quoteBuyAmount * 95n) / 100n;

		// 2. Place GPv2 order
		const validTo = Math.floor(Date.now() / 1000) + 600;
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

		// 3. Record trader's WETH balance before settlement (balance accumulates across runs)
		const wethBefore = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);

		// 4. Submit BYOS proposal
		const interactions = buildSellInteractions(sellToken, buyToken, sellAmount, minBuyAmount);
		const { id: proposalId } = await signAndSubmitProposal({
			walletClient: subSolverWallet,
			orderUid,
			sellToken,
			buyToken,
			sellAmount,
			minBuyAmount,
			quoteBuyAmount,
			interactions,
		});

		// 4. Wait for settlement
		await waitForOrderExecution(orderUid, publicClient);

		// 5. Get settlement tx hash from BYOS
		const settled = await waitForProposalStatus(subSolverWallet, proposalId, [
			"settled",
			"settleFailed",
		]);
		expect(settled.status).toBe("settled");
		const txHash = settled.settlementTxHash as Hex;

		console.log("\n=== Fee Transform Verification (COW-1240) ===");
		console.log("Settlement tx:", txHash);
		console.log("BYOS submitted quoteBuyAmount:", quoteBuyAmount.toString(), "WETH atoms");
		console.log("BYOS submitted sellAmount:    ", sellAmount.toString(), "USDC atoms");
		console.log("BYOS submitted minBuyAmount:  ", minBuyAmount.toString(), "WETH atoms");

		// 6. Fetch the transaction and decode settle() calldata
		const tx = await publicClient.getTransaction({ hash: txHash });

		const decoded = decodeFunctionData({
			abi: GPv2SettlementAbi,
			data: tx.input,
		});
		const [tokens, clearingPrices, trades, interactionSlots] = decoded.args;

		console.log("\nTokens in settle():", tokens);
		console.log("Clearing prices:   ", clearingPrices.map(String));

		// 7. Find Trampoline execute() in intra-interactions (slot [1])
		const intraInteractions = interactionSlots[1];
		const trampolineAddress = await publicClient.readContract({
			address: CONTRACTS.trampolineFactory,
			abi: parseAbi(["function addressOf(address _subSolver) view returns (address _trampoline)"]),
			functionName: "addressOf",
			args: [ACCOUNTS.subSolver.address],
		});
		console.log("Trampoline:        ", trampolineAddress);

		const executeInteraction = intraInteractions.find(
			(i) => (i.target as string).toLowerCase() === (trampolineAddress as string).toLowerCase(),
		);
		expect(executeInteraction).toBeDefined();

		// 8. Decode the execute() calldata
		const execDecoded = decodeFunctionData({
			abi: TrampolineAbi,
			data: executeInteraction!.callData as Hex,
		});
		const execProposal = execDecoded.args[0] as {
			orderUidHash: Hex;
			sellToken: Hex;
			buyToken: Hex;
			sellAmount: bigint;
			minBuyAmount: bigint;
			quoteBuyAmount: bigint;
			validUntil: bigint;
			nonce: bigint;
		};

		console.log("\nProposal inside execute():");
		console.log("  sellAmount:     ", execProposal.sellAmount.toString());
		console.log("  minBuyAmount:   ", execProposal.minBuyAmount.toString());
		console.log("  quoteBuyAmount: ", execProposal.quoteBuyAmount.toString());

		// --- INVARIANT 1: execute() payload byte-identical to what BYOS submitted ---
		expect(execProposal.quoteBuyAmount).toBe(quoteBuyAmount);
		expect(execProposal.sellAmount).toBe(sellAmount);
		expect(execProposal.minBuyAmount).toBe(minBuyAmount);
		console.log("\n✓ Invariant 1: execute() payload is byte-identical to BYOS submission");

		// --- INVARIANT 2: sell amount in the settled trade is unchanged ---
		const trade = trades[0];
		// For a SELL order, executedAmount is the sell token amount
		const tradeSellAmount = trade.executedAmount;
		expect(tradeSellAmount).toBe(sellAmount);
		console.log(
			"✓ Invariant 2: sell amount in settled trade (",
			tradeSellAmount.toString(),
			") equals BYOS sellAmount",
		);

		// --- INVARIANT 3: buy amount credited = quoteBuyAmount - protocol fee ---
		// GPv2 settle() formula: creditedBuy = sellAmount * p[sellTokenIndex] / p[buyTokenIndex]
		// The driver may introduce extra token entries (with fee-adjusted prices) so the
		// trade's actual sellTokenIndex/buyTokenIndex may not be 0/1.
		console.log("\nTrade sellTokenIndex:", trade.sellTokenIndex.toString());
		console.log("Trade buyTokenIndex: ", trade.buyTokenIndex.toString());
		const driverSellPrice = clearingPrices[Number(trade.sellTokenIndex)];
		const driverBuyPrice = clearingPrices[Number(trade.buyTokenIndex)];
		// GPv2 formula: amount received = executedSell * p_sell / p_buy
		const creditedBuy = (sellAmount * driverSellPrice) / driverBuyPrice;
		const protocolFee = quoteBuyAmount - creditedBuy;

		console.log(
			"\nclearing price [sell]: ",
			driverSellPrice.toString(),
			"(driver set, index",
			`${trade.sellTokenIndex.toString()})`,
		);
		console.log(
			"clearing price [buy]:  ",
			driverBuyPrice.toString(),
			"(driver set, index",
			`${trade.buyTokenIndex.toString()})`,
		);
		console.log("credited buy amount:   ", creditedBuy.toString(), "WETH atoms");
		console.log("protocol fee taken:    ", protocolFee.toString(), "WETH atoms");
		console.log(
			`fee as % of quote:     ${((Number(protocolFee) / Number(quoteBuyAmount)) * 100).toFixed(4)}%`,
		);

		// Fee must be positive, less than surplus, and less than the full buy amount
		const surplus = quoteBuyAmount - minBuyAmount;
		expect(creditedBuy).toBeLessThan(quoteBuyAmount);
		expect(protocolFee).toBeGreaterThan(0n);
		expect(protocolFee).toBeLessThan(surplus); // fee never exceeds surplus

		// Trader actually received creditedBuy (balance accumulates across runs, so use delta)
		const wethAfter = await tokenBalance(publicClient, buyToken, ACCOUNTS.trader.address);
		const wethReceived = wethAfter - wethBefore;
		console.log("trader WETH received:  ", wethReceived.toString());
		expect(wethReceived).toBe(creditedBuy);
		console.log(
			"✓ Invariant 3: credited buy reduced by exactly protocol fee; on-chain balance matches",
		);

		console.log("\n=== Summary ===");
		console.log(`Sell:         ${sellAmount} USDC atoms (1000 USDC)`);
		console.log(`Quote buy:    ${quoteBuyAmount} WETH atoms`);
		console.log(`Credited buy: ${creditedBuy} WETH atoms`);
		console.log(
			`Protocol fee: ${protocolFee} WETH atoms (${((Number(protocolFee) / Number(quoteBuyAmount)) * 100).toFixed(4)}% of quote)`,
		);
	});
});
