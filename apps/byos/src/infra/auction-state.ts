import { OrderKind, OrderStatus, SigningScheme } from "@byos/common";
import type { SettlementInteraction } from "@byos/common";
import type { Address, Hex } from "viem";
import type { OrderRecord } from "../domain/order.js";
import type { AuctionOrder } from "./api/types.js";

export interface AuctionState {
	auctionId: number;
	/** Keyed by lowercase order UID. */
	orders: Map<string, OrderRecord>;
	/** Keyed by lowercase token address. Value is native price scaled by 1e18. */
	prices: Map<string, bigint>;
}

let current: AuctionState | null = null;

export function setAuctionState(state: AuctionState): void {
	current = state;
}

export function getAuctionState(): AuctionState | null {
	return current;
}

export function clearAuctionState(): void {
	current = null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function mapKind(kind: string): OrderKind {
	if (kind === "sell") return OrderKind.SELL;
	if (kind === "buy") return OrderKind.BUY;
	throw new Error(`unknown order kind: ${kind}`);
}

function mapSigningScheme(scheme: string): SigningScheme {
	switch (scheme) {
		case "eip712":
			return SigningScheme.Eip712;
		case "ethsign":
			return SigningScheme.EthSign;
		case "eip1271":
			return SigningScheme.Eip1271;
		case "presign":
			return SigningScheme.PreSign;
		default:
			throw new Error(`unknown signing scheme: ${scheme}`);
	}
}

/**
 * Converts a /solve AuctionOrder to an OrderRecord.
 *
 * The driver normalises EthFlow orders before sending: sell token is already
 * WETH and validTo is already 0xffffffff. No EthFlow detection needed here.
 *
 * For presign orders the driver sends an empty signature; GPv2Settlement's
 * recoverPreSigner requires the owner address, so we use that instead.
 */
export function auctionOrderToRecord(order: AuctionOrder): OrderRecord {
	const erc20Balances = order.sellTokenSource === "erc20" && order.buyTokenDestination === "erc20";

	const preInteractions: SettlementInteraction[] = order.preInteractions.map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	const postInteractions: SettlementInteraction[] = order.postInteractions.map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	return {
		order: {
			sellToken: order.sellToken as Address,
			buyToken: order.buyToken as Address,
			receiver: (order.receiver ?? ZERO_ADDRESS) as Address,
			sellAmount: BigInt(order.sellAmount),
			buyAmount: BigInt(order.buyAmount),
			validTo: order.validTo,
			appData: order.appData as Hex,
			feeAmount: 0n,
			kind: mapKind(order.kind),
			partiallyFillable: order.partiallyFillable,
			signingScheme: mapSigningScheme(order.signingScheme),
			// presign orders: use owner address as signature (required by GPv2Settlement)
			signature: order.signingScheme === "presign" ? (order.owner as Hex) : (order.signature as Hex),
		},
		preInteractions,
		postInteractions,
		erc20Balances,
		status: OrderStatus.OPEN,
	};
}
