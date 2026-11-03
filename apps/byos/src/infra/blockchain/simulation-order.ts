import type { CowOrder } from "@byos/common";
import { BUY_ETH_ADDRESS, getWrappedTokenForChain, isSupportedChain } from "@cowprotocol/cow-sdk";
import { type Address, hashTypedData } from "viem";

// GPv2Order.Data's signed fields, in the contract's EIP-712 order.
const orderTypes = {
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

/**
 * The driver may replace the native buy token with its wrapped address in an
 * auction. Restore it only when the candidate digest matches the UID, so orders
 * actually signed to buy the wrapped token remain unchanged. This uses no IO
 * and works for every signing scheme: the UID always embeds the EIP-712 digest.
 * Call only after the envelope check has established ERC20 balance sources.
 */
export function simulationOrder(
	order: CowOrder,
	orderUid: string,
	chainId: number | undefined,
	settlement: Address,
): CowOrder {
	if (chainId === undefined || !isSupportedChain(chainId)) return order;
	const wrapped = getWrappedTokenForChain(chainId);
	if (!wrapped || order.buyToken.toLowerCase() !== wrapped.address.toLowerCase()) return order;

	const nativeOrder = { ...order, buyToken: BUY_ETH_ADDRESS as Address };
	const digest = hashTypedData({
		domain: {
			name: "Gnosis Protocol",
			version: "v2",
			chainId,
			verifyingContract: settlement,
		},
		types: orderTypes,
		primaryType: "Order",
		message: { ...nativeOrder, sellTokenBalance: "erc20", buyTokenBalance: "erc20" },
	});
	return digest.toLowerCase() === orderUid.slice(0, 66).toLowerCase() ? nativeOrder : order;
}
