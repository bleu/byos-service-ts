import {
	type Address,
	encodeAbiParameters,
	type Hex,
	hashTypedData,
	keccak256,
	recoverTypedDataAddress,
	type TypedDataDomain,
} from "viem";
import { interactionComponents } from "./abis/trampoline.js";
import type { ContractInteraction, Proposal } from "./types.js";

// --- Constants ---

export const DOMAIN_NAME = "BYOS";
export const DOMAIN_VERSION = "0.1";

/** Matches the on-chain PROPOSAL_TYPEHASH in ITrampoline.sol. */
export const PROPOSAL_TYPEHASH: Hex =
	"0x3d225121619eb0a7893a735942b7d03f8c171e24e347cd9fd29f74a1397af5b7";

/** Current ReadAuth.version. Bumping invalidates all outstanding read tokens. */
export const READ_AUTH_VERSION = 1n;

// --- EIP-712 Type Definitions ---

export const proposalDataTypes = {
	ProposalData: [
		{ name: "orderUidHash", type: "bytes32" },
		{ name: "sellAmount", type: "uint256" },
		{ name: "minBuyAmount", type: "uint256" },
		{ name: "quoteBuyAmount", type: "uint256" },
		{ name: "interactionsHash", type: "bytes32" },
		{ name: "validUntil", type: "uint256" },
		{ name: "nonce", type: "uint256" },
	],
} as const;

export const cancelProposalTypes = {
	CancelProposal: [{ name: "proposalId", type: "uint256" }],
} as const;

export const readAuthTypes = {
	ReadAuth: [{ name: "version", type: "uint256" }],
} as const;

// --- Domain ---

/** Builds the BYOS EIP-712 domain for a specific chain and TrampolineFactory. */
export function byosDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
	return {
		name: DOMAIN_NAME,
		version: DOMAIN_VERSION,
		chainId,
		verifyingContract,
	};
}

// --- Hashing ---

/**
 * Computes `interactionsHash = keccak256(abi.encode(interactions))`,
 * matching the Solidity `keccak256(abi.encode(interactions))` in ProposalSigning.sol.
 */
export function computeInteractionsHash(interactions: readonly ContractInteraction[]): Hex {
	const encoded = encodeAbiParameters(
		[{ type: "tuple[]", components: interactionComponents }],
		[
			interactions.map((i) => ({
				target: i.target,
				value: i.value,
				callData: i.callData,
			})),
		],
	);
	return keccak256(encoded);
}

// --- Recovery ---

/** Recovers the sub-solver address that signed a proposal. */
export async function recoverProposer(
	signature: Hex,
	domain: TypedDataDomain,
	proposal: Proposal,
	interactionsHash: Hex,
): Promise<Address> {
	return recoverTypedDataAddress({
		domain,
		types: proposalDataTypes,
		primaryType: "ProposalData",
		message: {
			orderUidHash: proposal.orderUidHash,
			sellAmount: proposal.sellAmount,
			minBuyAmount: proposal.minBuyAmount,
			quoteBuyAmount: proposal.quoteBuyAmount,
			interactionsHash,
			validUntil: proposal.validUntil,
			nonce: proposal.nonce,
		},
		signature,
	});
}

/** Recovers the sub-solver address from a cancellation signature. */
export async function recoverCanceller(
	signature: Hex,
	domain: TypedDataDomain,
	proposalId: bigint,
): Promise<Address> {
	return recoverTypedDataAddress({
		domain,
		types: cancelProposalTypes,
		primaryType: "CancelProposal",
		message: { proposalId },
		signature,
	});
}

/** Recovers the sub-solver address from a read-auth signature. */
export async function recoverReader(signature: Hex, domain: TypedDataDomain): Promise<Address> {
	return recoverTypedDataAddress({
		domain,
		types: readAuthTypes,
		primaryType: "ReadAuth",
		message: { version: READ_AUTH_VERSION },
		signature,
	});
}

// --- Signing ---

/** Signs a proposal on behalf of a sub-solver. Used by the reference sub-solver and tests. */
export async function signProposal(
	signTypedDataFn: (params: {
		domain: TypedDataDomain;
		types: typeof proposalDataTypes;
		primaryType: "ProposalData";
		message: Record<string, unknown>;
	}) => Promise<Hex>,
	domain: TypedDataDomain,
	proposal: Proposal,
	interactions: readonly ContractInteraction[],
): Promise<Hex> {
	const interactionsHash = computeInteractionsHash(interactions);
	return signTypedDataFn({
		domain,
		types: proposalDataTypes,
		primaryType: "ProposalData",
		message: {
			orderUidHash: proposal.orderUidHash,
			sellAmount: proposal.sellAmount,
			minBuyAmount: proposal.minBuyAmount,
			quoteBuyAmount: proposal.quoteBuyAmount,
			interactionsHash,
			validUntil: proposal.validUntil,
			nonce: proposal.nonce,
		},
	});
}

/** Signs a proposal cancellation. Used by the reference sub-solver and tests. */
export async function signCancellation(
	signTypedDataFn: (params: {
		domain: TypedDataDomain;
		types: typeof cancelProposalTypes;
		primaryType: "CancelProposal";
		message: Record<string, unknown>;
	}) => Promise<Hex>,
	domain: TypedDataDomain,
	proposalId: bigint,
): Promise<Hex> {
	return signTypedDataFn({
		domain,
		types: cancelProposalTypes,
		primaryType: "CancelProposal",
		message: { proposalId },
	});
}

/** Signs the read-auth bearer message. Used by the reference sub-solver and tests. */
export async function signReadAuth(
	signTypedDataFn: (params: {
		domain: TypedDataDomain;
		types: typeof readAuthTypes;
		primaryType: "ReadAuth";
		message: Record<string, unknown>;
	}) => Promise<Hex>,
	domain: TypedDataDomain,
): Promise<Hex> {
	return signTypedDataFn({
		domain,
		types: readAuthTypes,
		primaryType: "ReadAuth",
		message: { version: READ_AUTH_VERSION },
	});
}

/** Computes the EIP-712 hash for a ProposalData message (useful for testing). */
export function hashProposalData(
	domain: TypedDataDomain,
	proposal: Proposal,
	interactionsHash: Hex,
): Hex {
	return hashTypedData({
		domain,
		types: proposalDataTypes,
		primaryType: "ProposalData",
		message: {
			orderUidHash: proposal.orderUidHash,
			sellAmount: proposal.sellAmount,
			minBuyAmount: proposal.minBuyAmount,
			quoteBuyAmount: proposal.quoteBuyAmount,
			interactionsHash,
			validUntil: proposal.validUntil,
			nonce: proposal.nonce,
		},
	});
}
