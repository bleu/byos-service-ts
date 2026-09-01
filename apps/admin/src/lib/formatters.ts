import { formatUnits } from "viem";
import { gnosis, gnosisChiado, mainnet, sepolia } from "viem/chains";

const KNOWN_CHAINS = [mainnet, gnosis, sepolia, gnosisChiado];

function getChain(chainId: number) {
	return KNOWN_CHAINS.find((c) => c.id === chainId);
}

export function getChainId(): number {
	return Number(process.env.CHAIN_ID ?? "1");
}

export function getCowExplorerUrl(): string {
	return process.env.COW_EXPLORER_URL ?? "https://explorer.cow.fi";
}

export function cowExplorerOrderUrl(orderUid: string): string | null {
	const base = getCowExplorerUrl();
	return `${base}/orders/${orderUid}`;
}

export function blockExplorerAddressUrl(address: string): string | null {
	const baseUrl = getChain(getChainId())?.blockExplorers?.default?.url;
	if (!baseUrl) return null;
	return `${baseUrl}/address/${address}`;
}

export function blockExplorerTxUrl(txHash: string): string | null {
	const baseUrl = getChain(getChainId())?.blockExplorers?.default?.url;
	if (!baseUrl) return null;
	return `${baseUrl}/tx/${txHash}`;
}

const TENDERLY_NETWORK_SLUGS: Record<number, string> = {
	1: "mainnet",
	100: "gnosis",
	11155111: "sepolia",
	10200: "chiado",
};

export function tenderlyTxUrl(txHash: string): string | null {
	const slug = TENDERLY_NETWORK_SLUGS[getChainId()];
	if (!slug) return null;
	return `https://dashboard.tenderly.co/tx/${slug}/${txHash}`;
}

export function formatNativeAmount(amountWei: string): string {
	const bn = BigInt(amountWei);
	const symbol = getChain(getChainId())?.nativeCurrency?.symbol ?? "ETH";
	return `${formatUnits(bn, 18)} ${symbol}`;
}

export interface TxLinks {
	explorerUrl: string | null;
	tenderlyUrl: string | null;
}

export function txLinks(txHash: string | null): TxLinks {
	if (!txHash) return { explorerUrl: null, tenderlyUrl: null };
	return {
		explorerUrl: blockExplorerTxUrl(txHash),
		tenderlyUrl: tenderlyTxUrl(txHash),
	};
}
