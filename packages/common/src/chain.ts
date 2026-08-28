import {
	COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
	type EvmChainInfo,
	getChainInfo,
	isEvmChainInfo,
	isSupportedChain,
	ORDER_BOOK_PROD_CONFIG,
} from "@cowprotocol/cow-sdk";
import { type Address, type Chain, defineChain } from "viem";
import { foundry } from "viem/chains";

/**
 * viem chain definition for a configured `CHAIN_ID`, sourced from the cow-sdk.
 *
 * The sdk is the registry rather than a table of our own: it already carries
 * every chain CoW settles on, including the Multicall3 address viem needs to
 * batch reads, and a chain CoW adds or drops arrives with an sdk bump instead
 * of a hand edit here.
 *
 * Its `ChainInfo` is close to a viem `Chain` but not one — the sdk calls it "a
 * simplified version" and names the display field `label` where viem requires
 * `name` — so the fields are mapped explicitly.
 *
 * Throws rather than returning undefined: `CHAIN_ID` is read once at startup,
 * and a service pointed at a chain we cannot describe should not boot.
 */
export function evmChainFor(chainId: number): Chain {
	if (chainId === foundry.id) return LOCAL_CHAIN;

	if (!isSupportedChain(chainId)) {
		throw new Error(`chain ${chainId} is not supported by CoW Protocol`);
	}

	const info = getChainInfo(chainId);
	if (!info) {
		throw new Error(`chain ${chainId} has no chain definition in cow-sdk`);
	}

	// BYOS is EVM-only by construction: escrow collateral, the trampoline and
	// EIP-712 proposal signatures all assume it. Solana is the live case.
	if (!isEvmChainInfo(info)) {
		throw new Error(`chain ${chainId} (${info.label}) is not an EVM chain`);
	}

	return toViemChain(info);
}

/**
 * Anvil, for local development against the offline CoW stack. Not a chain CoW
 * settles on, so the sdk does not carry it.
 *
 * viem's `foundry` has no Multicall3 entry, so the canonical address is added:
 * an anvil forked from any real chain already has it deployed there. On a bare
 * anvil the address holds no code, the batched read comes back as per-call
 * failures, and the balance cache stays empty — every signer sits at the
 * lowest tier, which is the right way for this to degrade in development.
 */
const LOCAL_CHAIN: Chain = defineChain({
	...foundry,
	contracts: {
		multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
	},
});

function toViemChain(info: EvmChainInfo): Chain {
	const { name, symbol, decimals } = info.nativeCurrency;

	// The sdk types name and symbol as optional on every token, but a chain's
	// own native currency always carries them. Fall back to the chain label
	// rather than shipping "undefined" into a viem error message.
	return defineChain({
		id: info.id,
		name: info.label,
		nativeCurrency: {
			name: name ?? info.label,
			symbol: symbol ?? info.addressPrefix.toUpperCase(),
			decimals,
		},
		rpcUrls: {
			default: { http: [...info.rpcUrls.default.http] },
		},
		blockExplorers: {
			default: { name: info.blockExplorer.name, url: info.blockExplorer.url },
		},
		contracts: info.contracts,
		testnet: info.isTestnet,
	});
}

/** Whether `CHAIN_ID` names an EVM chain CoW settles on. For config
 * validation, where a boolean reads better than a caught throw. */
export function isSupportedEvmChain(chainId: number): boolean {
	try {
		evmChainFor(chainId);
		return true;
	} catch {
		return false;
	}
}

/**
 * CoW Protocol settlement contract address per chain, from the sdk.
 *
 * The sdk carries the same address on every EVM chain CoW settles on — it is
 * an immutable singleton — but is keyed per chain so a future divergence (e.g.
 * a V2 deployed only on a new chain) arrives as a sdk bump rather than a silent
 * wrong address.
 *
 * Throws for chains where CoW has no settlement contract (Solana, local anvil).
 * The caller should prefer `COW_PROTOCOL_SETTLEMENT_ADDRESS` override before
 * falling through here.
 */
export function settlementAddressFor(chainId: number): Address {
	if (chainId === foundry.id) return LOCAL_SETTLEMENT_ADDRESS;

	if (!isSupportedChain(chainId)) {
		throw new Error(`chain ${chainId} is not supported by CoW Protocol`);
	}

	const address = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[chainId];
	if (!address) {
		throw new Error(`chain ${chainId} has no CoW settlement contract`);
	}

	return address as Address;
}

/**
 * CoW Protocol orderbook API base URL per chain, from the sdk.
 *
 * Points to production (`api.cow.fi`). A barn/staging override belongs in the
 * caller's env var, not here: barn is an operational concern, not a chain
 * property.
 *
 * Throws for Solana and local anvil (no hosted orderbook for either).
 */
export function orderbookUrlFor(chainId: number): string {
	if (chainId === foundry.id) return LOCAL_ORDERBOOK_URL;

	if (!isSupportedChain(chainId)) {
		throw new Error(`chain ${chainId} is not supported by CoW Protocol`);
	}

	const url = ORDER_BOOK_PROD_CONFIG[chainId];
	if (!url) {
		throw new Error(`chain ${chainId} has no CoW orderbook URL`);
	}

	return url;
}

/** Anvil orderbook URL for the offline CoW stack used in local dev and e2e. */
const LOCAL_ORDERBOOK_URL = "http://localhost:8080";

/** Anvil settlement address — the same as the mainnet singleton, baked into
 * the offline-mode fork by e2e-stack.sh. */
const LOCAL_SETTLEMENT_ADDRESS: Address = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
