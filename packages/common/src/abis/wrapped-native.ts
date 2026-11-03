/** WETH9-compatible withdrawal, also used by WBNB and other wrapped natives. */
export const WrappedNativeAbi = [
	{
		type: "function",
		name: "withdraw",
		inputs: [{ name: "amount", type: "uint256" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;
