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
	// Structural invariant: minBuyAmount must not exceed maxBuyAmount
	if (proposal.minBuyAmount > proposal.maxBuyAmount) {
		return "AmountMismatch";
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
		// minBuyAmount must be at least the order's limit
		if (proposal.minBuyAmount < order.buyAmount) {
			return "AmountMismatch";
		}
	} else {
		// Buy orders: minBuyAmount must equal maxBuyAmount
		if (proposal.minBuyAmount !== proposal.maxBuyAmount) {
			return "AmountMismatch";
		}
		if (proposal.maxBuyAmount !== order.buyAmount) {
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
		// Limit price check uses maxBuyAmount: proposal_maxBuy * order_sell >= proposal_sell * order_buy
		if (proposal.maxBuyAmount * order.sellAmount < proposal.sellAmount * order.buyAmount) {
			return "AmountMismatch";
		}
		// minBuyAmount must also beat the scaled limit price
		if (proposal.minBuyAmount * order.sellAmount < proposal.sellAmount * order.buyAmount) {
			return "AmountMismatch";
		}
	} else {
		// Buy orders: minBuyAmount must equal maxBuyAmount
		if (proposal.minBuyAmount !== proposal.maxBuyAmount) {
			return "AmountMismatch";
		}
		if (proposal.maxBuyAmount === 0n || proposal.maxBuyAmount > order.buyAmount) {
			return "AmountMismatch";
		}
		if (proposal.sellAmount === 0n) {
			return "AmountMismatch";
		}
		// Limit price check: proposal_sell * order_buy <= proposal_maxBuy * order_sell
		if (proposal.sellAmount * order.buyAmount > proposal.maxBuyAmount * order.sellAmount) {
			return "AmountMismatch";
		}
	}
	return null;
}
