import {
	blockExplorerAddressUrl,
	blockExplorerTxUrl,
	formatNativeAmount,
	tenderlyTxUrl,
} from "@byos/common";

export { blockExplorerAddressUrl, blockExplorerTxUrl, formatNativeAmount, tenderlyTxUrl };

export function cowExplorerOrderUrl(orderUid: string, cowExplorerUrl: string): string | null {
	if (!cowExplorerUrl) return null;
	return `${cowExplorerUrl}/orders/${orderUid}`;
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
