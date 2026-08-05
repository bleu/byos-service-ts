/** ABI component definitions reused across trampoline and settlement encoding. */
export const proposalComponents = [
	{ name: "orderUidHash", type: "bytes32" },
	{ name: "sellAmount", type: "uint256" },
	{ name: "buyAmount", type: "uint256" },
	{ name: "validUntil", type: "uint256" },
	{ name: "nonce", type: "uint256" },
] as const;

export const interactionComponents = [
	{ name: "target", type: "address" },
	{ name: "value", type: "uint256" },
	{ name: "callData", type: "bytes" },
] as const;

export const TrampolineAbi = [
	{
		type: "function",
		name: "execute",
		inputs: [
			{ name: "_proposal", type: "tuple", components: proposalComponents },
			{ name: "_interactions", type: "tuple[]", components: interactionComponents },
			{ name: "_sellToken", type: "address" },
			{ name: "_buyToken", type: "address" },
			{ name: "_signature", type: "bytes" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "event",
		name: "Executed",
		inputs: [
			{ name: "_orderUidHash", type: "bytes32", indexed: true },
			{ name: "_delta", type: "uint256", indexed: false },
			{ name: "_floor", type: "uint256", indexed: false },
		],
	},
	{
		type: "error",
		name: "Trampoline_FloorNotMet",
		inputs: [
			{ name: "_delta", type: "uint256" },
			{ name: "_floor", type: "uint256" },
		],
	},
	{ type: "error", name: "Trampoline_InvalidSignature", inputs: [] },
	{ type: "error", name: "Trampoline_OnlySettlement", inputs: [] },
	{ type: "error", name: "Trampoline_ProposalExpired", inputs: [] },
	{ type: "error", name: "Trampoline_UnauthorizedSubmitter", inputs: [] },
	{ type: "error", name: "Trampoline_EthSettleBackFailed", inputs: [] },
] as const;
