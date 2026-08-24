/**
 * Shared viem clients for the e2e test suite.
 *
 * All test files talk to the same Anvil chain instance (--no-file-parallelism),
 * so a single set of clients is safe to share across imports.
 */
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACCOUNTS, CONFIG } from "./config.js";

export const anvilMainnet = defineChain({
	id: CONFIG.chainId,
	name: "Anvil Mainnet",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
});

export const publicClient = createPublicClient({
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

/** Anvil account #5 — the trader submitting GPv2 orders. */
export const traderWallet = createWalletClient({
	account: privateKeyToAccount(ACCOUNTS.trader.key),
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

/** Anvil account #4 — the sub-solver submitting proposals. */
export const subSolverWallet = createWalletClient({
	account: privateKeyToAccount(ACCOUNTS.subSolver.key),
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});

/** Anvil account #0 — the deployer, pre-funded with token balances. */
export const deployerWallet = createWalletClient({
	account: privateKeyToAccount(ACCOUNTS.baselineSolver.key),
	chain: anvilMainnet,
	transport: http(CONFIG.rpcUrl),
});
