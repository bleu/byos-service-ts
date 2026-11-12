import {
	blockExplorerAddressUrl as chainAddressUrl,
	formatNativeAmount as chainNativeAmount,
	tenderlyTxUrl as chainTenderlyTxUrl,
	blockExplorerTxUrl as chainTxUrl,
	nativeCurrencySymbol,
} from "@byos/common";

export { type SimulationFailureParams, tenderlySimulationUrl } from "@byos/common";

export function getChainId(): number {
	return Number(process.env.CHAIN_ID ?? "1");
}

export function getNativeCurrencySymbol(): string {
	return nativeCurrencySymbol(getChainId());
}

export function getCowExplorerUrl(): string {
	return process.env.COW_EXPLORER_URL ?? "https://explorer.cow.fi";
}

export function cowExplorerOrderUrl(orderUid: string): string | null {
	return `${getCowExplorerUrl()}/orders/${orderUid}`;
}

export function blockExplorerAddressUrl(address: string): string | null {
	return chainAddressUrl(address, getChainId());
}

export function blockExplorerTxUrl(txHash: string): string | null {
	return chainTxUrl(txHash, getChainId());
}

export function tenderlyTxUrl(txHash: string): string | null {
	return chainTenderlyTxUrl(txHash, getChainId());
}

export function formatNativeAmount(amountWei: string): string {
	return chainNativeAmount(amountWei, getChainId());
}

export interface TxLinks {
	explorerUrl: string | null;
	tenderlyUrl: string | null;
}

export function txLinks(txHash: string | null): TxLinks {
	if (!txHash) return { explorerUrl: null, tenderlyUrl: null };
	return { explorerUrl: blockExplorerTxUrl(txHash), tenderlyUrl: tenderlyTxUrl(txHash) };
}
