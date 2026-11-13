import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { FlashLoanRouterAbi } from "./abis/flash-loan-router.js";

/** Flash loan hint as sent by the driver in the auction order. */
export interface FlashloanHint {
	liquidityProvider: Address;
	protocolAdapter: Address;
	receiver: Address;
	token: Address;
	amount: bigint;
}

/**
 * A generic settlement wrapper that wraps `settle()` calldata into an outer
 * call targeting a different contract. Used for flash loan router and
 * potentially other atomic bundle contracts in the future.
 */
export interface SettlementWrapper {
	/** The contract to call instead of the settlement contract. */
	address: Address;
	/** Wraps raw settle() calldata into the outer call's calldata. */
	encode: (settleCalldata: Hex) => Hex;
}

/**
 * Builds a SettlementWrapper for the FlashLoanRouter given a hint and the
 * router address.
 */
export function flashLoanWrapper(hint: FlashloanHint, routerAddress: Address): SettlementWrapper {
	return {
		address: routerAddress,
		encode: (settleCalldata: Hex) =>
			encodeFunctionData({
				abi: FlashLoanRouterAbi,
				functionName: "flashLoanAndSettle",
				args: [
					[
						{
							amount: hint.amount,
							borrower: hint.protocolAdapter,
							lender: hint.liquidityProvider,
							token: hint.token,
						},
					],
					settleCalldata,
				],
			}),
	};
}
