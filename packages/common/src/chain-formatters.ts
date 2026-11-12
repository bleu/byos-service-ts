import { type Chain, formatUnits } from "viem";
import { gnosisChiado } from "viem/chains";
import { evmChainFor } from "./chain.js";

/** Display metadata follows the same SDK registry as the service's RPC clients. */
function displayChainFor(chainId: number): Chain | undefined {
	// Preserve historical Chiado links without enabling it for settlement.
	if (chainId === gnosisChiado.id) return gnosisChiado;
	try {
		return evmChainFor(chainId);
	} catch {
		// Notifications must remain usable for unknown historical chain IDs.
		return undefined;
	}
}

export function nativeCurrencySymbol(chainId: number): string {
	return displayChainFor(chainId)?.nativeCurrency.symbol ?? "ETH";
}

export function formatNativeAmount(amount: string | bigint, chainId: number): string {
	const currency = displayChainFor(chainId)?.nativeCurrency;
	return `${formatUnits(BigInt(amount), currency?.decimals ?? 18)} ${currency?.symbol ?? "ETH"}`;
}

export function blockExplorerAddressUrl(address: string, chainId: number): string | null {
	const base = displayChainFor(chainId)?.blockExplorers?.default.url;
	return base ? `${base}/address/${address}` : null;
}

export function blockExplorerTxUrl(txHash: string, chainId: number): string | null {
	const base = displayChainFor(chainId)?.blockExplorers?.default.url;
	return base ? `${base}/tx/${txHash}` : null;
}

// Tenderly aliases are service-specific, separate from the SDK's chain registry.
// Avalanche's canonical slug is listed by https://api.tenderly.co/api/v1/public-networks.
const TENDERLY_NETWORK_SLUGS: Readonly<Partial<Record<number, string>>> = {
	1: "mainnet",
	56: "bsc",
	100: "gnosis",
	11155111: "sepolia",
	10200: "chiado",
	43114: "avalanche-mainnet",
};

export function tenderlyTxUrl(txHash: string, chainId: number): string | null {
	const slug = TENDERLY_NETWORK_SLUGS[chainId];
	return slug ? `https://dashboard.tenderly.co/tx/${slug}/${txHash}` : null;
}

export interface SimulationFailureParams {
	chainId: number;
	blockNumber: string;
	timestamp: number;
	from: string;
	to: string;
	calldata: string;
}

export function tenderlySimulationUrl(params: SimulationFailureParams): string | null {
	if (!TENDERLY_NETWORK_SLUGS[params.chainId]) return null;
	const query = new URLSearchParams({
		network: String(params.chainId),
		blockNumber: params.blockNumber,
		from: params.from,
		contractAddress: params.to,
		rawFunctionInput: params.calldata,
	});
	return `https://dashboard.tenderly.co/simulator/new?${query.toString()}`;
}
