import { type ContractInteraction, type Proposal, signProposal } from "@byos/common";
import type { Address, Hex, TypedDataDomain } from "viem";
import { encodeFunctionData, keccak256 } from "viem";
import { amountIn, amountOut } from "./routing.js";

/** Orderbook order as seen by the sub-solver. */
export interface Order {
	uid: Hex;
	sellToken: Address;
	buyToken: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	kind: "sell" | "buy";
}

/** Parameters for building a routed proposal. */
export interface RouteParams {
	router: Address;
	trampoline: Address;
	reserveSell: bigint;
	reserveBuy: bigint;
	validUntil: bigint;
	nonce: bigint;
	extraInteractions: ContractInteraction[];
}

/** A fully signed proposal ready for submission to BYOS. */
export interface SignedProposal {
	orderUid: Hex;
	sellAmount: bigint;
	minBuyAmount: bigint;
	maxBuyAmount: bigint;
	interactions: ContractInteraction[];
	validUntil: bigint;
	nonce: bigint;
	signature: Hex;
}

/** ERC20 approve ABI for building approve interactions. */
const erc20ApproveAbi = [
	{
		type: "function",
		name: "approve",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "nonpayable",
	},
] as const;

/** Uniswap V2 Router swap ABIs. */
const routerAbi = [
	{
		type: "function",
		name: "swapExactTokensForTokens",
		inputs: [
			{ name: "amountIn", type: "uint256" },
			{ name: "amountOutMin", type: "uint256" },
			{ name: "path", type: "address[]" },
			{ name: "to", type: "address" },
			{ name: "deadline", type: "uint256" },
		],
		outputs: [{ name: "amounts", type: "uint256[]" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "swapTokensForExactTokens",
		inputs: [
			{ name: "amountOut", type: "uint256" },
			{ name: "amountInMax", type: "uint256" },
			{ name: "path", type: "address[]" },
			{ name: "to", type: "address" },
			{ name: "deadline", type: "uint256" },
		],
		outputs: [{ name: "amounts", type: "uint256[]" }],
		stateMutability: "nonpayable",
	},
] as const;

// biome-ignore lint/suspicious/noExplicitAny: viem overloaded signTypedData types
type SignFn = (params: any) => Promise<Hex>;

/**
 * Build a routed proposal through Uniswap V2 and sign it.
 * Returns null if the pool can't beat the order's limit price.
 */
export async function buildProposal(
	order: Order,
	params: RouteParams,
	domain: TypedDataDomain,
	signFn: SignFn,
): Promise<SignedProposal | null> {
	let sellAmount: bigint;
	let buyAmount: bigint;

	if (order.kind === "sell") {
		sellAmount = order.sellAmount;
		const out = amountOut(sellAmount, params.reserveSell, params.reserveBuy);
		if (out === null || out < order.buyAmount) return null;
		buyAmount = out;
	} else {
		buyAmount = order.buyAmount;
		const cost = amountIn(buyAmount, params.reserveSell, params.reserveBuy);
		if (cost === null || cost > order.sellAmount) return null;
		sellAmount = cost;
	}

	// Build interactions: approve + swap + extras
	const deadline = params.validUntil;
	const path = [order.sellToken, order.buyToken];

	const approveCalldata = encodeFunctionData({
		abi: erc20ApproveAbi,
		functionName: "approve",
		args: [params.router, sellAmount],
	});

	const swapCalldata =
		order.kind === "sell"
			? encodeFunctionData({
					abi: routerAbi,
					functionName: "swapExactTokensForTokens",
					args: [sellAmount, buyAmount, path, params.trampoline, deadline],
				})
			: encodeFunctionData({
					abi: routerAbi,
					functionName: "swapTokensForExactTokens",
					args: [buyAmount, sellAmount, path, params.trampoline, deadline],
				});

	const interactions: ContractInteraction[] = [
		{ target: order.sellToken, value: 0n, callData: approveCalldata },
		{ target: params.router, value: 0n, callData: swapCalldata },
		...params.extraInteractions,
	];

	// Sign via EIP-712
	const orderUidHash = keccak256(order.uid);
	// Reference subsolver does not use aggressive slippage: min = max
	const proposal: Proposal = {
		orderUidHash,
		sellAmount,
		minBuyAmount: buyAmount,
		maxBuyAmount: buyAmount,
		validUntil: params.validUntil,
		nonce: params.nonce,
	};

	const signature = await signProposal(signFn, domain, proposal, interactions);

	return {
		orderUid: order.uid,
		sellAmount,
		minBuyAmount: buyAmount,
		maxBuyAmount: buyAmount,
		interactions,
		validUntil: params.validUntil,
		nonce: params.nonce,
		signature,
	};
}
