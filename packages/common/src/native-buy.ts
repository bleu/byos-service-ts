import { BUY_ETH_ADDRESS } from "@cowprotocol/cow-sdk";
import { type Address, encodeFunctionData } from "viem";
import { WrappedNativeAbi } from "./abis/wrapped-native.js";
import type { SettlementInteraction } from "./trampoline.js";

/**
 * A native-output proposal retains its signed native buy token. When the
 * driver's auction uses wrapped native, wrap its delivery after trampoline
 * execution so the driver's automatic unwrap has the funds it expects.
 */
export function encodeNativeBuyWrap(
	proposalBuyToken: Address,
	routingBuyToken: Address,
	amount: bigint,
): SettlementInteraction[] {
	if (
		proposalBuyToken.toLowerCase() !== BUY_ETH_ADDRESS.toLowerCase() ||
		routingBuyToken.toLowerCase() === BUY_ETH_ADDRESS.toLowerCase()
	)
		return [];
	return [
		{
			target: routingBuyToken,
			value: amount,
			callData: encodeFunctionData({ abi: WrappedNativeAbi, functionName: "deposit" }),
		},
	];
}
