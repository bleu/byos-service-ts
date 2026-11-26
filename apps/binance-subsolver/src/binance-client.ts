import * as crypto from "node:crypto";
import type { Address, Hex } from "viem";

const BASE_URL = "https://web3.binance.com/build";

export interface QuoteData {
	quoteId: string;
	vendorName: string;
	executionMode: "SWAP" | "RFQ";
	binanceChainId: string;
	fromTokenAmount: string;
	toTokenAmount: string;
	tradeFee: string;
	estimateGasFee: string;
	priceImpactPercent: string;
	router: string;
	approveTarget: Address;
	isBest: boolean;
	feeAmount: string | null;
	feeToken: string | null;
	actualSwapAmount: string | null;
}

export interface SwapTx {
	from: Address;
	to: Address;
	data: Hex;
	value: string;
	gas: string;
	gasPrice: string;
	minReceiveAmount: string;
	slippagePercent: string;
}

interface SwapData {
	executionMode: "SWAP" | "RFQ";
	tx: SwapTx;
}

interface ApiResponse<T> {
	success: boolean;
	code: number;
	message: string;
	data: T;
}

export class BinanceClient {
	constructor(
		private readonly apiKey: string,
		private readonly secretKey: string,
		private readonly chainId: number,
	) {}

	private makeHeaders(
		method: "GET" | "POST",
		apiPath: string,
		queryString: string,
		body = "",
	): Record<string, string> {
		const timestamp = new Date().toISOString();
		const requestPath = `/build${apiPath}${queryString ? `?${queryString}` : ""}`;
		const preHash = timestamp + method + requestPath + body;
		const signature = crypto
			.createHmac("sha256", this.secretKey)
			.update(preHash, "utf8")
			.digest("base64");
		return {
			"X-OC-APIKEY": this.apiKey,
			"X-OC-TIMESTAMP": timestamp,
			"X-OC-SIGN": signature,
			"Content-Type": "application/json",
		};
	}

	private async apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
		const queryString = new URLSearchParams(params).toString();
		const headers = this.makeHeaders("GET", path, queryString);
		const url = `${BASE_URL}${path}?${queryString}`;
		const res = await fetch(url, { headers });
		const json = (await res.json()) as ApiResponse<T>;
		if (!json.success) {
			throw new Error(`Binance API error [${json.code}]: ${json.message}`);
		}
		return json.data;
	}

	/**
	 * Fetches all SWAP-mode quotes for a sell order. Returns an empty array if no
	 * SWAP quote is available (e.g. Binance returns RFQ-only or no route).
	 */
	async getQuotes(
		fromToken: Address,
		toToken: Address,
		sellAmount: bigint,
		walletAddress: Address,
		slippageBps: number,
	): Promise<QuoteData[]> {
		const slippagePercent = (slippageBps / 100).toString();
		const quotes = await this.apiGet<QuoteData[]>("/api/v1/dex/aggregator/quote", {
			binanceChainId: this.chainId.toString(),
			amount: sellAmount.toString(),
			fromTokenAddress: fromToken,
			toTokenAddress: toToken,
			userWalletAddress: walletAddress,
			slippagePercent,
		});
		return quotes.filter((q) => q.executionMode === "SWAP");
	}

	/**
	 * Builds an unsigned swap transaction for a given quoteId.
	 */
	async buildSwap(
		quoteId: string,
		fromToken: Address,
		toToken: Address,
		sellAmount: bigint,
		walletAddress: Address,
		slippageBps: number,
	): Promise<SwapTx> {
		const slippagePercent = (slippageBps / 100).toString();
		const data = await this.apiGet<SwapData>("/api/v1/dex/aggregator/swap", {
			binanceChainId: this.chainId.toString(),
			amount: sellAmount.toString(),
			fromTokenAddress: fromToken,
			toTokenAddress: toToken,
			userWalletAddress: walletAddress,
			quoteId,
			slippagePercent,
		});
		return data.tx;
	}
}
