/** Minimal ABI for the CoW Protocol FlashLoanRouter contract.
 * Only includes flashLoanAndSettle — the single function solvers call. */
export const FlashLoanRouterAbi = [
	{
		type: "function",
		name: "flashLoanAndSettle",
		inputs: [
			{
				name: "loans",
				type: "tuple[]",
				internalType: "struct LoanRequest.Data[]",
				components: [
					{ name: "amount", type: "uint256", internalType: "uint256" },
					{
						name: "borrower",
						type: "address",
						internalType: "contract IFlashLoanSolverWrapper",
					},
					{ name: "lender", type: "address", internalType: "address" },
					{ name: "token", type: "address", internalType: "contract IERC20" },
				],
			},
			{ name: "settlement", type: "bytes", internalType: "bytes" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;
