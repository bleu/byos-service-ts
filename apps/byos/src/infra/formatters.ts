import { formatUnits } from "viem";
import { gnosis, gnosisChiado, mainnet, sepolia } from "viem/chains";

// Chains CoW Protocol operates on. Extend as needed.
const KNOWN_CHAINS = [mainnet, gnosis, sepolia, gnosisChiado];

function getChain(chainId: number) {
	return KNOWN_CHAINS.find((c) => c.id === chainId);
}

// --- URL builders (return null when data is unavailable — callers must handle) ---

export function cowExplorerOrderUrl(orderUid: string, cowExplorerUrl: string): string | null {
	if (!cowExplorerUrl) return null;
	return `${cowExplorerUrl}/orders/${orderUid}`;
}

export function blockExplorerAddressUrl(address: string, chainId: number): string | null {
	const baseUrl = getChain(chainId)?.blockExplorers?.default?.url;
	if (!baseUrl) return null;
	return `${baseUrl}/address/${address}`;
}

export function blockExplorerTxUrl(txHash: string, chainId: number): string | null {
	const baseUrl = getChain(chainId)?.blockExplorers?.default?.url;
	if (!baseUrl) return null;
	return `${baseUrl}/tx/${txHash}`;
}

const TENDERLY_NETWORK_SLUGS: Record<number, string> = {
	1: "mainnet",
	100: "gnosis",
	11155111: "sepolia",
	10200: "chiado",
};

export function tenderlyTxUrl(txHash: string, chainId: number): string | null {
	const slug = TENDERLY_NETWORK_SLUGS[chainId];
	if (!slug) return null;
	return `https://dashboard.tenderly.co/tx/${slug}/${txHash}`;
}

export function formatNativeAmount(amount: string | bigint, chainId: number): string {
	const bn = typeof amount === "bigint" ? amount : BigInt(amount);
	const symbol = getChain(chainId)?.nativeCurrency?.symbol ?? "ETH";
	return `${formatUnits(bn, 18)} ${symbol}`;
}

// --- Slack mrkdwn helpers ---

/** Wraps text in a Slack mrkdwn link. Falls back to plain label when url is null. */
export function slackLink(url: string | null | undefined, label: string): string {
	if (!url) return label;
	return `<${url}|${label}>`;
}

export interface SlackFormatterContext {
	chainId: number;
	cowExplorerUrl: string;
}

/** Full order UID with CoW Explorer link. */
export function slackOrderUid(orderUid: string, ctx: SlackFormatterContext): string {
	const url = cowExplorerOrderUrl(orderUid, ctx.cowExplorerUrl);
	return slackLink(url, orderUid);
}

/** Full address with block explorer link. */
export function slackAddress(address: string, ctx: SlackFormatterContext): string {
	return slackLink(blockExplorerAddressUrl(address, ctx.chainId), address);
}

/** Full tx hash with block explorer link. */
export function slackTx(txHash: string, ctx: SlackFormatterContext): string {
	return slackLink(blockExplorerTxUrl(txHash, ctx.chainId), txHash);
}

/** Native amount formatted with symbol. */
export function slackAmount(amount: string | bigint, ctx: SlackFormatterContext): string {
	return formatNativeAmount(amount, ctx.chainId);
}

// --- Admin API URL bundles (attach to JSON responses) ---

export interface TxLinks {
	explorerUrl: string | null;
	tenderlyUrl: string | null;
}

export function txLinks(txHash: string | null, chainId: number): TxLinks {
	if (!txHash) return { explorerUrl: null, tenderlyUrl: null };
	return {
		explorerUrl: blockExplorerTxUrl(txHash, chainId),
		tenderlyUrl: tenderlyTxUrl(txHash, chainId),
	};
}
