import { BUY_ETH_ADDRESS, type CowOrder, SigningScheme } from "@byos/common";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vitest";
import { auctionOrderToRecord } from "../../auction-state.js";
import { simulationOrder } from "../simulation-order.js";
import { nativeBuyAuctionOrder } from "./fixtures/native-buy-order.js";

const settlement = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";
const types = {
	Order: [
		{ name: "sellToken", type: "address" },
		{ name: "buyToken", type: "address" },
		{ name: "receiver", type: "address" },
		{ name: "sellAmount", type: "uint256" },
		{ name: "buyAmount", type: "uint256" },
		{ name: "validTo", type: "uint32" },
		{ name: "appData", type: "bytes32" },
		{ name: "feeAmount", type: "uint256" },
		{ name: "kind", type: "string" },
		{ name: "partiallyFillable", type: "bool" },
		{ name: "sellTokenBalance", type: "string" },
		{ name: "buyTokenBalance", type: "string" },
	],
} as const;

function typedOrder(order: CowOrder) {
	return {
		domain: { name: "Gnosis Protocol", version: "v2", chainId: 56, verifyingContract: settlement },
		types,
		primaryType: "Order",
		message: { ...order, sellTokenBalance: "erc20", buyTokenBalance: "erc20" },
	} as const;
}

describe("simulation order", () => {
	it("recovers the incident order's real owner instead of the empty account", async () => {
		const { order } = auctionOrderToRecord(nativeBuyAuctionOrder);
		const wrongOwner = await recoverTypedDataAddress({
			...typedOrder(order),
			signature: order.signature,
		});
		expect(wrongOwner.toLowerCase()).toBe("0xe715402629d7ab32fffa9f90c5f963a99f2d24e7");

		const restored = simulationOrder(order, nativeBuyAuctionOrder.uid, 56, settlement);
		expect(hashTypedData(typedOrder(restored))).toBe(nativeBuyAuctionOrder.uid.slice(0, 66));
		const owner = await recoverTypedDataAddress({
			...typedOrder(restored),
			signature: restored.signature,
		});
		expect(owner.toLowerCase()).toBe(nativeBuyAuctionOrder.owner);
		expect(order.buyToken.toLowerCase()).toBe(nativeBuyAuctionOrder.buyToken.toLowerCase());
	});

	it.each([
		SigningScheme.Eip712,
		SigningScheme.EthSign,
		SigningScheme.Eip1271,
		SigningScheme.PreSign,
	])("restores the signed token independently of the %s signature scheme", (signingScheme) => {
		const { order } = auctionOrderToRecord(nativeBuyAuctionOrder);
		const restored = simulationOrder(
			{ ...order, signingScheme },
			nativeBuyAuctionOrder.uid,
			56,
			settlement,
		);
		expect(restored.buyToken.toLowerCase()).toBe(BUY_ETH_ADDRESS.toLowerCase());
	});

	it("preserves an order actually signed to buy WBNB", () => {
		const { order } = auctionOrderToRecord(nativeBuyAuctionOrder);
		const uid = `${hashTypedData(typedOrder(order))}${nativeBuyAuctionOrder.uid.slice(66)}`;
		expect(simulationOrder(order, uid, 56, settlement)).toBe(order);
	});

	it("does not guess when the native candidate does not match the UID", () => {
		const { order } = auctionOrderToRecord(nativeBuyAuctionOrder);
		const changed = { ...order, buyAmount: order.buyAmount + 1n };
		expect(simulationOrder(changed, nativeBuyAuctionOrder.uid, 56, settlement)).toBe(changed);
	});

	it("does not normalize unrelated ERC20 orders or a different chain", () => {
		const { order } = auctionOrderToRecord(nativeBuyAuctionOrder);
		const changed = { ...order, buyToken: order.sellToken };
		expect(simulationOrder(changed, nativeBuyAuctionOrder.uid, 56, settlement)).toBe(changed);
		expect(simulationOrder(order, nativeBuyAuctionOrder.uid, 1, settlement)).toBe(order);
		expect(simulationOrder(order, nativeBuyAuctionOrder.uid, undefined, settlement)).toBe(order);
	});
});
