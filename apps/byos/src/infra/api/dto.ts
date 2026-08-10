import {
	type ContractInteraction,
	type CreateProposalRequest,
	computeInteractionsHash,
} from "@byos/common";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import type { Proposal } from "../../domain/proposal.js";

/** Parsed proposal fields ready for domain use. */
export interface ParsedProposal {
	orderUid: string;
	orderUidHash: Hex;
	sellAmount: bigint;
	buyAmount: bigint;
	interactions: ContractInteraction[];
	interactionsHash: Hex;
	validUntil: bigint;
	nonce: bigint;
	signature: Hex;
}

/** Parses a CreateProposalRequest into domain-ready fields. */
export function parseCreateProposalRequest(body: CreateProposalRequest): ParsedProposal {
	const orderUid = body.orderUid.toLowerCase();
	const orderUidHex = (orderUid.startsWith("0x") ? orderUid : `0x${orderUid}`) as Hex;
	const orderUidHash = keccak256(orderUidHex);

	const interactions: ContractInteraction[] = body.interactions.map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	const interactionsHash = computeInteractionsHash(interactions);

	return {
		orderUid: orderUidHex,
		orderUidHash,
		sellAmount: BigInt(body.sellAmount),
		buyAmount: BigInt(body.buyAmount),
		interactions,
		interactionsHash,
		validUntil: BigInt(body.validUntil),
		nonce: BigInt(body.nonce),
		signature: body.signature as Hex,
	};
}

/** Converts a domain Proposal to the GET /proposal/:id response body. */
export function proposalToGetResponse(p: Proposal) {
	return {
		id: p.id,
		subSolver: p.subSolver,
		orderUid: p.orderUid,
		sellAmount: p.sellAmount.toString(),
		buyAmount: p.buyAmount.toString(),
		validUntil: p.validUntil.toString(),
		status: p.status,
		...(p.rejectionReason ? { rejectionReason: p.rejectionReason } : {}),
		...(p.settlementTxHash ? { settlementTxHash: p.settlementTxHash } : {}),
		...(p.penaltyTxHash ? { penaltyTxHash: p.penaltyTxHash } : {}),
		...(p.pendingCancellation ? { pendingCancellation: true } : {}),
	};
}

/** Converts a domain Proposal to metadata for list responses. */
export function proposalToMetadata(p: Proposal) {
	return {
		id: p.id,
		subSolver: p.subSolver,
		validUntil: p.validUntil.toString(),
		status: p.status,
	};
}

/** Converts a list of Proposals to the list response body. */
export function proposalToListResponse(proposals: Proposal[]) {
	return {
		proposals: proposals.map(proposalToMetadata),
	};
}
