import type { Address, Hex } from "viem";

/** Environment-driven URLs. Default to localhost for running tests against the e2e stack. */
export const CONFIG = {
	rpcUrl: process.env.RPC_URL ?? "http://localhost:8545",
	orderbookUrl: process.env.ORDERBOOK_URL ?? "http://localhost:8080",
	byosPublicUrl: process.env.BYOS_PUBLIC_URL ?? "http://localhost:19585",
	byosInternalUrl: process.env.BYOS_INTERNAL_URL ?? "http://localhost:19586",
	chainId: Number(process.env.CHAIN_ID ?? "1"),
};

/** Deterministic contract addresses from the baked anvil state (COW-1237). */
export const CONTRACTS = {
	gpv2Settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address,
	gpv2Authenticator: "0x2c4c28DDBdAc9C5E7055b4C863b72eA0149D8aFE" as Address,
	vaultRelayer: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as Address,
	escrow: "0x537f9b7061616706F6ffeaf0aa3E616093F92EF5" as Address,
	trampolineFactory: "0x1bcE115f36DCB1F40B85ed61870D491e4a4A9A0b" as Address,
	weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
	usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
	dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address,
	uniswapV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address,
};

/**
 * Account map from the e2e plan doc. Addresses and keys are from Anvil's
 * default mnemonic: "test test test test test test test test test test test junk"
 */
export const ACCOUNTS = {
	baselineSolver: {
		address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
		key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
	},
	escrowOperator: {
		address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
		key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
	},
	escrowAdmin: {
		address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address,
		key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
	},
	byosSolver: {
		address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address,
		key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex,
	},
	subSolver: {
		address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address,
		key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as Hex,
	},
	trader: {
		address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address,
		key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex,
	},
};

/** GPv2 EIP-712 domain for order signing. */
export const GPV2_DOMAIN = {
	name: "Gnosis Protocol",
	version: "v2",
	chainId: CONFIG.chainId,
	verifyingContract: CONTRACTS.gpv2Settlement,
} as const;

/** GPv2 order EIP-712 types. */
export const GPV2_ORDER_TYPES = {
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
