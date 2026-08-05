import { OrderKind } from "@cowprotocol/cow-sdk";
import { type Address, encodeFunctionData, type Hex } from "viem";
import { GPv2SettlementAbi } from "./abis/gpv2-settlement.js";
import type { SettlementInteraction } from "./trampoline.js";
import { encodeTrampolineInteractions } from "./trampoline.js";
import type { ContractInteraction, Proposal } from "./types.js";

export { OrderKind } from "@cowprotocol/cow-sdk";

/**
 * Signing scheme as reported by the CoW orderbook API (string wire format).
 * The cow-sdk SigningScheme uses numeric values (0,1,2,3) which don't match
 * the orderbook wire format, so we keep our own string enum.
 */
export enum SigningScheme {
	Eip712 = "eip712",
	EthSign = "ethSign",
	Eip1271 = "eip1271",
	PreSign = "preSign",
}

/** The slice of an orderbook order that settle() encoding needs. */
export interface CowOrder {
	sellToken: Address;
	buyToken: Address;
	/** Zero address means "same as owner" (GPv2 convention). */
	receiver: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	validTo: number;
	appData: Hex;
	feeAmount: bigint;
	kind: OrderKind;
	partiallyFillable: boolean;
	signingScheme: SigningScheme;
	signature: Hex;
}

/**
 * Encodes the trade's `flags` word per GPv2Trade.extractOrder:
 * bit 0 = order kind, bit 1 = partial fill, bits 5-6 = signing scheme.
 */
function tradeFlags(order: CowOrder): bigint {
	let flags = 0;
	if (order.kind === OrderKind.BUY) {
		flags |= 1;
	}
	if (order.partiallyFillable) {
		flags |= 1 << 1;
	}
	switch (order.signingScheme) {
		case SigningScheme.Eip712:
			break;
		case SigningScheme.EthSign:
			flags |= 1 << 5;
			break;
		case SigningScheme.Eip1271:
			flags |= 2 << 5;
			break;
		case SigningScheme.PreSign:
			flags |= 3 << 5;
			break;
	}
	return BigInt(flags);
}

function toInteractionTuples(interactions: readonly SettlementInteraction[]) {
	return interactions.map((i) => ({
		target: i.target,
		value: i.value,
		callData: i.callData,
	}));
}

/**
 * Encodes the full `settle()` calldata simulating this proposal.
 *
 * Tokens `[sell, buy]`, clearing prices `[proposal.buyAmount, proposal.sellAmount]`,
 * the order as a single trade, and the trampoline intra-interactions.
 */
export function encodeSettle(
	order: CowOrder,
	proposal: Proposal,
	trampoline: Address,
	route: readonly ContractInteraction[],
	proposalSignature: Hex,
	preInteractions: readonly SettlementInteraction[],
	postInteractions: readonly SettlementInteraction[],
): Hex {
	const executedAmount = order.kind === OrderKind.SELL ? proposal.sellAmount : proposal.buyAmount;

	const trade = {
		sellTokenIndex: 0n,
		buyTokenIndex: 1n,
		receiver: order.receiver,
		sellAmount: order.sellAmount,
		buyAmount: order.buyAmount,
		validTo: order.validTo,
		appData: order.appData,
		feeAmount: order.feeAmount,
		flags: tradeFlags(order),
		executedAmount,
		signature: order.signature,
	};

	const [transferIntra, executeIntra] = encodeTrampolineInteractions(
		trampoline,
		order.sellToken,
		proposal,
		route,
		order.buyToken,
		proposalSignature,
	);

	return encodeFunctionData({
		abi: GPv2SettlementAbi,
		functionName: "settle",
		args: [
			[order.sellToken, order.buyToken],
			[proposal.buyAmount, proposal.sellAmount],
			[trade],
			[
				toInteractionTuples(preInteractions),
				toInteractionTuples([transferIntra, executeIntra]),
				toInteractionTuples(postInteractions),
			],
		],
	});
}
