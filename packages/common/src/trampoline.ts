import { type Address, encodeFunctionData, type Hex } from "viem";
import { Erc20Abi } from "./abis/erc20.js";
import { TrampolineAbi } from "./abis/trampoline.js";
import type { ContractInteraction, Proposal } from "./types.js";

export interface SettlementInteraction {
	target: Address;
	value: bigint;
	callData: Hex;
}

/**
 * Encodes the two settlement intra-interactions that wrap a sub-solver's
 * proposal in a Trampoline `execute` call.
 *
 * 1. `sellToken.transfer(trampoline, sellAmount)` — push trade capital
 * 2. `trampoline.execute(proposal, interactions, sellToken, buyToken, signature)` — run the route
 */
export function encodeTrampolineInteractions(
	trampoline: Address,
	sellToken: Address,
	proposal: Proposal,
	interactions: readonly ContractInteraction[],
	buyToken: Address,
	signature: Hex,
): [SettlementInteraction, SettlementInteraction] {
	const transferCalldata = encodeFunctionData({
		abi: Erc20Abi,
		functionName: "transfer",
		args: [trampoline, proposal.sellAmount],
	});

	const transfer: SettlementInteraction = {
		target: sellToken,
		value: 0n,
		callData: transferCalldata,
	};

	const executeCalldata = encodeFunctionData({
		abi: TrampolineAbi,
		functionName: "execute",
		args: [
			{
				orderUidHash: proposal.orderUidHash,
				sellAmount: proposal.sellAmount,
				minBuyAmount: proposal.minBuyAmount,
				maxBuyAmount: proposal.maxBuyAmount,
				validUntil: proposal.validUntil,
				nonce: proposal.nonce,
			},
			interactions.map((i) => ({
				target: i.target,
				value: i.value,
				callData: i.callData,
			})),
			sellToken,
			buyToken,
			signature,
		],
	});

	const execute: SettlementInteraction = {
		target: trampoline,
		value: 0n,
		callData: executeCalldata,
	};

	return [transfer, execute];
}
