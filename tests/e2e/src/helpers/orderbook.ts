/**
 * CoW Protocol orderbook helpers: sign GPv2 orders, submit to orderbook API,
 * poll for execution, manage token balances.
 *
 * Ported from offline-mode/test/utils/order-helpers.ts (ethers → viem).
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { mineBlock } from "./chain.js";
import { CONFIG, CONTRACTS, GPV2_DOMAIN, GPV2_ORDER_TYPES } from "./config.js";

export interface GpvOrder {
	sellToken: Address;
	buyToken: Address;
	receiver: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	validTo: number;
	appData: Hex;
	feeAmount: bigint;
	kind: "sell" | "buy";
	partiallyFillable: boolean;
	sellTokenBalance: "erc20";
	buyTokenBalance: "erc20";
}

/**
 * Sign a GPv2 order via EIP-712 and submit it to the orderbook REST API.
 * Returns the order UID assigned by the orderbook.
 */
export async function signAndSubmitOrder(
	walletClient: WalletClient,
	order: GpvOrder,
): Promise<string> {
	const signature = await walletClient.signTypedData({
		domain: GPV2_DOMAIN,
		types: GPV2_ORDER_TYPES,
		primaryType: "Order",
		message: {
			...order,
			sellAmount: order.sellAmount,
			buyAmount: order.buyAmount,
			feeAmount: order.feeAmount,
		},
	});

	const payload = {
		sellToken: order.sellToken,
		buyToken: order.buyToken,
		receiver: order.receiver,
		sellAmount: order.sellAmount.toString(),
		buyAmount: order.buyAmount.toString(),
		validTo: order.validTo,
		appData: order.appData,
		feeAmount: order.feeAmount.toString(),
		kind: order.kind,
		partiallyFillable: order.partiallyFillable,
		sellTokenBalance: order.sellTokenBalance,
		buyTokenBalance: order.buyTokenBalance,
		from: walletClient.account?.address,
		signature,
		signingScheme: "eip712",
	};

	const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Order submission failed (${resp.status}): ${text}`);
	}

	const uid = await resp.text();
	return uid.replace(/"/g, "");
}

/**
 * Poll the orderbook for order status until fulfilled, expired, or timeout.
 * Mines blocks to trigger autopilot auction cycles.
 */
export async function waitForOrderExecution(
	orderUid: string,
	client: PublicClient,
	maxWaitMs = 120_000,
): Promise<{ status: string }> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders/${orderUid}`);
		if (resp.ok) {
			const data = (await resp.json()) as { status: string };
			if (data.status === "fulfilled") return data;
			if (data.status === "expired" || data.status === "cancelled") {
				throw new Error(`Order ${data.status}`);
			}
		}

		// Mine a block to trigger autopilot auction cycle
		await mineBlock(client);
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`Order not fulfilled within ${maxWaitMs}ms`);
}

/** Approve the VaultRelayer to spend a token (max allowance). */
export async function approveVaultRelayer(
	walletClient: WalletClient,
	publicClient: PublicClient,
	token: Address,
): Promise<void> {
	const hash = await walletClient.sendTransaction({
		to: token,
		data: encodeFunctionData({
			abi: erc20Abi,
			functionName: "approve",
			args: [CONTRACTS.vaultRelayer, maxUint256],
		}),
	});
	await publicClient.waitForTransactionReceipt({ hash });
}

/** Transfer tokens from Anvil account #0 (deployer) to a target address. */
export async function fundToken(
	fromWallet: WalletClient,
	publicClient: PublicClient,
	token: Address,
	to: Address,
	amount: bigint,
): Promise<void> {
	const hash = await fromWallet.sendTransaction({
		to: token,
		data: encodeFunctionData({
			abi: erc20Abi,
			functionName: "transfer",
			args: [to, amount],
		}),
	});
	await publicClient.waitForTransactionReceipt({ hash });
}

/** Read ERC-20 balance. */
export async function tokenBalance(
	client: PublicClient,
	token: Address,
	account: Address,
): Promise<bigint> {
	return client.readContract({
		address: token,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [account],
	});
}

/** Deploy the sub-solver's Trampoline via TrampolineFactory.ensureDeployed(). */
export async function ensureTrampolineDeployed(
	walletClient: WalletClient,
	publicClient: PublicClient,
	subSolver: Address,
): Promise<Address> {
	const hash = await walletClient.sendTransaction({
		to: CONTRACTS.trampolineFactory,
		data: encodeFunctionData({
			abi: [
				{
					type: "function",
					name: "ensureDeployed",
					inputs: [{ name: "_subSolver", type: "address" }],
					outputs: [{ name: "_instance", type: "address" }],
					stateMutability: "nonpayable",
				},
			],
			functionName: "ensureDeployed",
			args: [subSolver],
		}),
	});
	await publicClient.waitForTransactionReceipt({ hash });

	// Read the deployed address
	return publicClient.readContract({
		address: CONTRACTS.trampolineFactory,
		abi: [
			{
				type: "function",
				name: "addressOf",
				inputs: [{ name: "_subSolver", type: "address" }],
				outputs: [{ name: "_trampoline", type: "address" }],
				stateMutability: "view",
			},
		],
		functionName: "addressOf",
		args: [subSolver],
	});
}

/** Deposit ETH to the Escrow contract for a sub-solver. */
export async function depositToEscrow(
	walletClient: WalletClient,
	publicClient: PublicClient,
	subSolver: Address,
	amount: bigint,
): Promise<void> {
	const hash = await walletClient.sendTransaction({
		to: CONTRACTS.escrow,
		data: encodeFunctionData({
			abi: [
				{
					type: "function",
					name: "deposit",
					inputs: [{ name: "_subSolver", type: "address" }],
					outputs: [],
					stateMutability: "payable",
				},
			],
			functionName: "deposit",
			args: [subSolver],
		}),
		value: amount,
	});
	await publicClient.waitForTransactionReceipt({ hash });
}

/** Get Uniswap V2 router reverse quote (how much input for a desired output). */
export async function getAmountsIn(
	client: PublicClient,
	amountOut: bigint,
	path: Address[],
): Promise<readonly bigint[]> {
	return client.readContract({
		address: CONTRACTS.uniswapV2Router,
		abi: [
			{
				type: "function",
				name: "getAmountsIn",
				inputs: [
					{ type: "uint256", name: "amountOut" },
					{ type: "address[]", name: "path" },
				],
				outputs: [{ type: "uint256[]", name: "amounts" }],
				stateMutability: "view",
			},
		],
		functionName: "getAmountsIn",
		args: [amountOut, path],
	});
}

/**
 * Poll the orderbook for any trade on the order. For partial fills where
 * the order stays "open", this checks the trades endpoint instead of status.
 * Mines blocks to trigger autopilot auction cycles.
 */
export async function waitForTrade(
	orderUid: string,
	client: PublicClient,
	maxWaitMs = 120_000,
): Promise<{ trades: unknown[] }> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const resp = await fetch(`${CONFIG.orderbookUrl}/api/v1/trades?orderUid=${orderUid}`);
		if (resp.ok) {
			const trades = (await resp.json()) as unknown[];
			if (trades.length > 0) return { trades };
		}

		await mineBlock(client);
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`No trades for order ${orderUid} within ${maxWaitMs}ms`);
}

/** Get Uniswap V2 router quote for a swap path. */
export async function getAmountsOut(
	client: PublicClient,
	amountIn: bigint,
	path: Address[],
): Promise<readonly bigint[]> {
	return client.readContract({
		address: CONTRACTS.uniswapV2Router,
		abi: [
			{
				type: "function",
				name: "getAmountsOut",
				inputs: [
					{ type: "uint256", name: "amountIn" },
					{ type: "address[]", name: "path" },
				],
				outputs: [{ type: "uint256[]", name: "amounts" }],
				stateMutability: "view",
			},
		],
		functionName: "getAmountsOut",
		args: [amountIn, path],
	});
}
