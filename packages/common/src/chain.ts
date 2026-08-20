import {
	type EvmChainInfo,
	getChainInfo,
	isEvmChainInfo,
	isSupportedChain,
	SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { type Chain, defineChain } from "viem";
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
 * Minimum escrow collateral per chain, in escrow-token wei.
 *
 * TODO(COW-1265): unmeasured placeholders, deliberately identical across
 * chains. Differentiating them is the point — settlement gas differs by orders
 * of magnitude between mainnet and an L2, so the collateral that makes a
 * sub-solver worth trusting differs too. Treat every number here as a guess
 * until real traffic and real gas prices say otherwise.
 *
 * Exhaustive over `SupportedChainId` on purpose: adding a chain to the sdk
 * becomes a compile error here rather than a silent zero. `null` is the way to
 * say "BYOS does not operate here", not an oversight.
 */
const MIN_COLLATERAL_WEI: Record<SupportedChainId, bigint | null> = {
	[SupportedChainId.MAINNET]: 10n ** 16n,
	[SupportedChainId.BNB]: 10n ** 16n,
	[SupportedChainId.GNOSIS_CHAIN]: 10n ** 16n,
	[SupportedChainId.POLYGON]: 10n ** 16n,
	[SupportedChainId.BASE]: 10n ** 16n,
	[SupportedChainId.PLASMA]: 10n ** 16n,
	[SupportedChainId.ARBITRUM_ONE]: 10n ** 16n,
	[SupportedChainId.AVALANCHE]: 10n ** 16n,
	[SupportedChainId.INK]: 10n ** 16n,
	[SupportedChainId.LINEA]: 10n ** 16n,
	[SupportedChainId.SEPOLIA]: 10n ** 16n,
	// Non-EVM: no escrow contract, no trampoline, no EIP-712 proposals.
	[SupportedChainId.SOLANA]: null,
};

/** Anvil, matching LOCAL_CHAIN above. */
const LOCAL_MIN_COLLATERAL_WEI = 10n ** 16n;

/**
 * Default minimum escrow collateral for a chain. `MIN_COLLATERAL` overrides it
 * where a deployment needs to.
 *
 * Feeds three things, only one of which is a rate limit: the validator's
 * accept/reject threshold, the Track A penalty parameter `c_l`, and the
 * request-path escrow floor gate.
 */
export function minCollateralFor(chainId: number): bigint {
	if (chainId === foundry.id) return LOCAL_MIN_COLLATERAL_WEI;

	if (!isSupportedChain(chainId)) {
		throw new Error(`chain ${chainId} is not supported by CoW Protocol`);
	}

	const min = MIN_COLLATERAL_WEI[chainId];
	if (min === null) {
		throw new Error(`chain ${chainId} has no escrow collateral — BYOS does not operate there`);
	}

	return min;
}
