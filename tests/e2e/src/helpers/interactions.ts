/**
 * Uniswap V2 interaction builders for e2e proposals.
 *
 * Both helpers return an [approve, swap] pair of ContractInteraction objects
 * that can be included directly in a BYOS proposal.
 */
import type { ContractInteraction } from "@byos/common";
import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import { CONTRACTS } from "./config.js";

const ERC20_APPROVE_ABI = [
	{
		type: "function" as const,
		name: "approve",
		inputs: [
			{ type: "address", name: "spender" },
			{ type: "uint256", name: "amount" },
		],
		outputs: [{ type: "bool" }],
	},
];

const SWAP_EXACT_FOR_ABI = [
	{
		type: "function" as const,
		name: "swapExactTokensForTokens",
		inputs: [
			{ type: "uint256", name: "amountIn" },
			{ type: "uint256", name: "amountOutMin" },
			{ type: "address[]", name: "path" },
			{ type: "address", name: "to" },
			{ type: "uint256", name: "deadline" },
		],
		outputs: [{ type: "uint256[]", name: "amounts" }],
	},
];

const SWAP_FOR_EXACT_ABI = [
	{
		type: "function" as const,
		name: "swapTokensForExactTokens",
		inputs: [
			{ type: "uint256", name: "amountOut" },
			{ type: "uint256", name: "amountInMax" },
			{ type: "address[]", name: "path" },
			{ type: "address", name: "to" },
			{ type: "uint256", name: "deadline" },
		],
		outputs: [{ type: "uint256[]", name: "amounts" }],
	},
];

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

/** Approve + swapExactTokensForTokens — for sell orders. */
export function buildSellInteractions(
	sellToken: Address,
	buyToken: Address,
	sellAmount: bigint,
	minBuyAmount: bigint,
): ContractInteraction[] {
	return [
		{
			target: sellToken,
			value: 0n,
			callData: encodeFunctionData({
				abi: ERC20_APPROVE_ABI,
				functionName: "approve",
				args: [CONTRACTS.uniswapV2Router, sellAmount],
			}),
		},
		{
			target: CONTRACTS.uniswapV2Router,
			value: 0n,
			callData: encodeFunctionData({
				abi: SWAP_EXACT_FOR_ABI,
				functionName: "swapExactTokensForTokens",
				args: [
					sellAmount,
					minBuyAmount,
					[sellToken, buyToken],
					CONTRACTS.gpv2Settlement,
					deadline(),
				],
			}),
		},
	];
}

/** Approve + swapTokensForExactTokens — for buy orders. */
export function buildBuyInteractions(
	sellToken: Address,
	buyToken: Address,
	buyAmount: bigint,
	maxSellAmount: bigint,
): ContractInteraction[] {
	return [
		{
			target: sellToken,
			value: 0n,
			callData: encodeFunctionData({
				abi: ERC20_APPROVE_ABI,
				functionName: "approve",
				args: [CONTRACTS.uniswapV2Router, maxSellAmount],
			}),
		},
		{
			target: CONTRACTS.uniswapV2Router,
			value: 0n,
			callData: encodeFunctionData({
				abi: SWAP_FOR_EXACT_ABI,
				functionName: "swapTokensForExactTokens",
				args: [
					buyAmount,
					maxSellAmount,
					[sellToken, buyToken],
					CONTRACTS.gpv2Settlement,
					deadline(),
				],
			}),
		},
	];
}
