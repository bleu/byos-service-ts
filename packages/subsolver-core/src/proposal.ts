import { type ContractInteraction, type Proposal, signProposal } from "@byos/common";
import type { Address, Hex, TypedDataDomain } from "viem";
import { keccak256 } from "viem";
import type { ProviderRoute } from "./provider.js";

export interface ProposalOrder {
	uid: Hex;
	sellToken: Address;
	buyToken: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	kind: "sell" | "buy";
}

/** A fully signed proposal ready for BYOS submission. */
export interface SignedProposal {
	orderUid: Hex;
	sellToken: Address;
	buyToken: Address;
	sellAmount: bigint;
	minBuyAmount: bigint;
	quoteBuyAmount: bigint;
	interactions: ContractInteraction[];
	validUntil: bigint;
	nonce: bigint;
	signature: Hex;
}

// viem's signTypedData has a deliberately overloaded generic signature.
// biome-ignore lint/suspicious/noExplicitAny: adapter boundary for a viem account
export type SignProposalData = (params: any) => Promise<Hex>;

/** Signs a provider route using the partial order amount and protected floor. */
export async function buildProposalFromRoute(
	order: ProposalOrder,
	route: ProviderRoute,
	validUntil: bigint,
	nonce: bigint,
	domain: TypedDataDomain,
	signFn: SignProposalData,
): Promise<SignedProposal | null> {
	if (order.kind !== "sell" || route.minBuyAmount < order.buyAmount) return null;
	const proposal: Proposal = {
		orderUidHash: keccak256(order.uid),
		sellToken: order.sellToken,
		buyToken: order.buyToken,
		sellAmount: order.sellAmount,
		minBuyAmount: route.minBuyAmount,
		quoteBuyAmount: route.quoteBuyAmount,
		validUntil,
		nonce,
	};
	const signature = await signProposal(signFn, domain, proposal, route.interactions);
	return {
		orderUid: order.uid,
		sellToken: order.sellToken,
		buyToken: order.buyToken,
		sellAmount: order.sellAmount,
		minBuyAmount: route.minBuyAmount,
		quoteBuyAmount: route.quoteBuyAmount,
		interactions: route.interactions,
		validUntil,
		nonce,
		signature,
	};
}
