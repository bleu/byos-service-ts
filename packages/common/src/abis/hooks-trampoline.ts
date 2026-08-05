export const HooksTrampolineAbi = [
	{
		type: "function",
		name: "execute",
		inputs: [
			{
				name: "hooks",
				type: "tuple[]",
				components: [
					{ name: "target", type: "address" },
					{ name: "callData", type: "bytes" },
					{ name: "gasLimit", type: "uint256" },
				],
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;
