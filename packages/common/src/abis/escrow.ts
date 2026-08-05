export const EscrowAbi = [
	{
		type: "function",
		name: "effectiveBalance",
		inputs: [{ name: "_subSolver", type: "address" }],
		outputs: [{ name: "_effectiveBalance", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "debit",
		inputs: [
			{ name: "_subSolver", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_reason", type: "bytes32" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "frozen",
		inputs: [{ name: "_subSolver", type: "address" }],
		outputs: [{ name: "_isFrozen", type: "bool" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "freeze",
		inputs: [{ name: "_subSolver", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "unfreeze",
		inputs: [{ name: "_subSolver", type: "address" }],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "deposit",
		inputs: [{ name: "_subSolver", type: "address" }],
		outputs: [],
		stateMutability: "payable",
	},
	{
		type: "event",
		name: "Deposited",
		inputs: [
			{ name: "_subSolver", type: "address", indexed: true },
			{ name: "_amount", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "Debited",
		inputs: [
			{ name: "_subSolver", type: "address", indexed: true },
			{ name: "_amount", type: "uint256", indexed: false },
			{ name: "_reason", type: "bytes32", indexed: false },
		],
	},
	{
		type: "event",
		name: "Frozen",
		inputs: [{ name: "_subSolver", type: "address", indexed: true }],
	},
	{
		type: "event",
		name: "Unfrozen",
		inputs: [{ name: "_subSolver", type: "address", indexed: true }],
	},
] as const;
