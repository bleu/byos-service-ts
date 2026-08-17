import type { Address, Hex } from "viem";

/**
 * On-chain Proposal struct matching Trampoline.execute's first parameter.
 * Used by EIP-712 signing, trampoline encoding, and settlement encoding.
 */
export interface Proposal {
	orderUidHash: Hex;
	sellAmount: bigint;
	minBuyAmount: bigint;
	quotedBuyAmount: bigint;
	validUntil: bigint;
	nonce: bigint;
}

/**
 * On-chain Interaction struct matching Trampoline.execute's second parameter.
 * Distinct from the wire DTO Interaction (which uses string amounts).
 */
export interface ContractInteraction {
	target: Address;
	value: bigint;
	callData: Hex;
}
