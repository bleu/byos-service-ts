import {
	type CowOrder,
	OrderKind,
	type RejectionReason,
	type SettlementInteraction,
} from "@byos/common";
import type { Proposal } from "./proposal.js";

/** Immutable orderbook order with its pre/post hook interactions. */
export interface OrderRecord {
	order: CowOrder;
	preInteractions: SettlementInteraction[];
	postInteractions: SettlementInteraction[];
	/** True if both sell and buy token balances are erc20 (not Balancer vault). */
	erc20Balances: boolean;
}

/**
 * Validates the proposal against the order's envelope constraints.
 * Returns null if the proposal passes, or a RejectionReason if it fails.
 */
export function checkEnvelope(record: OrderRecord, proposal: Proposal): RejectionReason | null {
	if (!record.erc20Balances) {
		return "UnsupportedOrder";
	}
	if (record.order.partiallyFillable) {
		return checkPartialFill(record.order, proposal);
	}
	return checkFillOrKill(record.order, proposal);
}

function checkFillOrKill(order: CowOrder, proposal: Proposal): RejectionReason | null {
	if (order.kind === OrderKind.SELL) {
		if (proposal.sellAmount !== order.sellAmount) {
			return "AmountMismatch";
		}
	} else {
		if (proposal.buyAmount !== order.buyAmount) {
			return "AmountMismatch";
		}
	}
	return null;
}

function checkPartialFill(order: CowOrder, proposal: Proposal): RejectionReason | null {
	if (order.kind === OrderKind.SELL) {
		if (proposal.sellAmount === 0n || proposal.sellAmount > order.sellAmount) {
			return "AmountMismatch";
		}
		// Limit price check: proposal_buy * order_sell >= proposal_sell * order_buy
		// This ensures the user gets at least the limit price per unit
		if (proposal.buyAmount * order.sellAmount < proposal.sellAmount * order.buyAmount) {
			return "AmountMismatch";
		}
	} else {
		if (proposal.buyAmount === 0n || proposal.buyAmount > order.buyAmount) {
			return "AmountMismatch";
		}
		if (proposal.sellAmount === 0n) {
			return "AmountMismatch";
		}
		// Limit price check: proposal_sell * order_buy <= proposal_buy * order_sell
		if (proposal.sellAmount * order.buyAmount > proposal.buyAmount * order.sellAmount) {
			return "AmountMismatch";
		}
	}
	return null;
}
