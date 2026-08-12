export const gpv2InteractionComponents = [
	{ name: "target", type: "address" },
	{ name: "value", type: "uint256" },
	{ name: "callData", type: "bytes" },
] as const;

export const gpv2TradeComponents = [
	{ name: "sellTokenIndex", type: "uint256" },
	{ name: "buyTokenIndex", type: "uint256" },
	{ name: "receiver", type: "address" },
	{ name: "sellAmount", type: "uint256" },
	{ name: "buyAmount", type: "uint256" },
	{ name: "validTo", type: "uint32" },
	{ name: "appData", type: "bytes32" },
	{ name: "feeAmount", type: "uint256" },
	{ name: "flags", type: "uint256" },
	{ name: "executedAmount", type: "uint256" },
	{ name: "signature", type: "bytes" },
] as const;

export const GPv2SettlementAbi = [
	{
		type: "function",
		name: "settle",
		inputs: [
			{ name: "tokens", type: "address[]" },
			{ name: "clearingPrices", type: "uint256[]" },
			{ name: "trades", type: "tuple[]", components: gpv2TradeComponents },
			{
				name: "interactions",
				type: "tuple[][3]",
				components: gpv2InteractionComponents,
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;
