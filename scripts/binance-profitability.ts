/**
 * Binance Profitability Analysis
 *
 * Identifies which token pairs would be most profitable with Binance DEX routes,
 * by comparing Binance's quoted amounts against historical CoW Protocol execution.
 *
 * Usage:
 *   RPC_URL=... BINANCE_API_KEY=... BINANCE_SECRET_KEY=... npx tsx scripts/binance-profitability.ts
 */

import "dotenv/config";
import * as crypto from "node:crypto";
import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { bsc } from "viem/chains";

// ============ INPUTS ============
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL env variable is required");
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
if (!BINANCE_API_KEY) throw new Error("BINANCE_API_KEY env variable is required");
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
if (!BINANCE_SECRET_KEY) throw new Error("BINANCE_SECRET_KEY env variable is required");

const BLOCKS_BEHIND_TO_SEARCH = 2000n;
const GPV2_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41" as const;
const ORDERBOOK_API = "https://api.cow.fi/bnb/api/v1";
const BINANCE_BASE_URL = "https://web3.binance.com/build";
const BSC_CHAIN_ID = "56";
const SLIPPAGE_PERCENT = "0.5";
const MAX_ORDERS = 50;
// ================================

const client = createPublicClient({ chain: bsc, transport: http(RPC_URL) });

const TRADE_ABI = parseAbi([
	"event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)",
]);

const ERC20_ABI = parseAbi(["function symbol() view returns (string)"]);

// ─── Binance API helpers ──────────────────────────────────────────────────────

function makeHeaders(
	method: "GET" | "POST",
	apiPath: string,
	queryString: string,
	body = "",
): Record<string, string> {
	const timestamp = new Date().toISOString();
	const requestPath = `/build${apiPath}${queryString ? `?${queryString}` : ""}`;
	const preHash = timestamp + method + requestPath + body;
	const signature = crypto
		.createHmac("sha256", BINANCE_SECRET_KEY!)
		.update(preHash, "utf8")
		.digest("base64");
	return {
		"X-OC-APIKEY": BINANCE_API_KEY!,
		"X-OC-TIMESTAMP": timestamp,
		"X-OC-SIGN": signature,
		"Content-Type": "application/json",
	};
}

async function binanceGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
	const queryString = new URLSearchParams(params).toString();
	const headers = makeHeaders("GET", path, queryString);
	const url = `${BINANCE_BASE_URL}${path}?${queryString}`;
	try {
		const res = await fetch(url, { headers });
		const json = (await res.json()) as {
			success: boolean;
			code: number;
			message: string;
			data: T;
		};
		if (!json.success) {
			console.log(`  Binance error [${json.code}]: ${json.message}`);
			return null;
		}
		return json.data;
	} catch {
		return null;
	}
}

// ─── Step 1: Collect order UIDs from recent Trade events ──────────────────────

async function getRecentOrderUids(): Promise<string[]> {
	const currentBlock = await client.getBlockNumber();
	const fromBlock = currentBlock - BLOCKS_BEHIND_TO_SEARCH;
	console.log(`Scanning blocks ${fromBlock}–${currentBlock} for Trade events...`);

	const logs = await client.getLogs({
		address: GPV2_SETTLEMENT,
		event: TRADE_ABI[0],
		fromBlock,
		toBlock: currentBlock,
	});

	console.log(`Found ${logs.length} Trade event(s)`);
	const recent = logs.slice(-MAX_ORDERS);

	return recent.map((log) => {
		const { args } = decodeEventLog({ abi: TRADE_ABI, data: log.data, topics: log.topics });
		return args.orderUid as string;
	});
}

// ─── Step 2: Fetch full order details from orderbook ─────────────────────────

interface Order {
	uid: string;
	creationDate: string;
	kind: string;
	partiallyFillable: boolean;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	executedBuyAmount: string;
	executedSellAmount: string;
	gasCost: string | null;
	status: string;
}

async function fetchOrder(uid: string): Promise<Order | null> {
	try {
		const res = await fetch(`${ORDERBOOK_API}/orders/${uid}`);
		if (!res.ok) return null;
		return (await res.json()) as Order;
	} catch {
		return null;
	}
}

// ─── Step 3: Fetch Binance quote ──────────────────────────────────────────────

interface QuoteData {
	quoteId: string;
	executionMode: "SWAP" | "RFQ";
	toTokenAmount: string;
}

interface SwapTx {
	data: string;
	minReceiveAmount: string;
}

interface SwapData {
	executionMode: "SWAP" | "RFQ";
	tx: SwapTx;
}

async function fetchBinanceQuote(
	sellToken: string,
	buyToken: string,
	sellAmount: bigint,
): Promise<bigint | null> {
	const quotes = await binanceGet<QuoteData[]>("/api/v1/dex/aggregator/quote", {
		binanceChainId: BSC_CHAIN_ID,
		amount: sellAmount.toString(),
		fromTokenAddress: sellToken,
		toTokenAddress: buyToken,
		userWalletAddress: GPV2_SETTLEMENT,
		slippagePercent: SLIPPAGE_PERCENT,
	});
	if (!quotes || quotes.length === 0) return null;
	const swapQuotes = quotes.filter((q) => q.executionMode === "SWAP");
	if (swapQuotes.length === 0) return null;

	// Build swap txs for all quotes in parallel, pick smallest calldata.
	const swapTxs = await Promise.all(
		swapQuotes.map((q) =>
			binanceGet<SwapData>("/api/v1/dex/aggregator/swap", {
				binanceChainId: BSC_CHAIN_ID,
				amount: sellAmount.toString(),
				fromTokenAddress: sellToken,
				toTokenAddress: buyToken,
				userWalletAddress: GPV2_SETTLEMENT,
				quoteId: q.quoteId,
				slippagePercent: SLIPPAGE_PERCENT,
			}),
		),
	);
	const pairs = swapQuotes
		.map((q, i) => ({ quote: q, swapTx: swapTxs[i]?.tx }))
		.filter((p): p is { quote: QuoteData; swapTx: SwapTx } => p.swapTx !== undefined);
	if (pairs.length === 0) return null;
	const best = pairs.reduce((a, b) => (a.swapTx.data.length <= b.swapTx.data.length ? a : b));
	return BigInt(best.swapTx.minReceiveAmount);
}

// ─── Step 4: Fetch native price of buy token ──────────────────────────────────

async function fetchNativePrice(token: string): Promise<number | null> {
	try {
		const res = await fetch(`${ORDERBOOK_API}/token/${token}/native_price`);
		if (!res.ok) return null;
		const data = (await res.json()) as { price: number };
		return data.price;
	} catch {
		return null;
	}
}

// ─── Step 5: Get token symbols via multicall ──────────────────────────────────

async function getTokenSymbols(tokens: string[]): Promise<Map<string, string>> {
	const results = await client.multicall({
		contracts: tokens.map((token) => ({
			address: token as `0x${string}`,
			abi: ERC20_ABI,
			functionName: "symbol" as const,
		})),
		allowFailure: true,
	});

	const map = new Map<string, string>();
	for (let i = 0; i < tokens.length; i++) {
		const key = tokens[i]?.toLowerCase();
		const result = results[i];
		if (result?.status === "success") {
			map.set(key, result.result as string);
		} else {
			map.set(key, tokens[i]?.slice(2, 8).toUpperCase());
		}
	}
	return map;
}

// ─── Step 6: Score calculation ────────────────────────────────────────────────

/**
 * Score measures the surplus Binance would provide over actual execution,
 * relative to the size of the trade (normalised ratio).
 *
 * gasInBuyToken = (gasCost × 10²¹) / priceAtoms
 * score = (binanceBuyAmount − gasInBuyToken − executedBuyAmount) × 10²¹ / executedBuyAmount
 *
 * A score of 1×10²¹ means Binance would have given 100% more buy tokens.
 * Divide by 10¹⁷ to get basis points, or by 10¹⁹ to get a percentage.
 */
function calculateScore(
	binanceBuyAmount: bigint,
	executedBuyAmount: bigint,
	gasCost: bigint,
	price: number,
): bigint {
	if (executedBuyAmount === 0n) return 0n;
	const priceAtoms = BigInt(Math.round(price * 1e21));
	if (priceAtoms === 0n) return 0n;
	const gasInBuyToken = (gasCost * 10n ** 21n) / priceAtoms;
	const surplus = binanceBuyAmount - gasInBuyToken - executedBuyAmount;
	return (surplus * 10n ** 21n) / executedBuyAmount;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log("=== Binance Profitability Analysis ===\n");

	// 1. Collect order UIDs from recent Settlement Trade events
	const uids = await getRecentOrderUids();
	if (uids.length === 0) {
		console.log("No recent trades found. Try increasing BLOCKS_BEHIND_TO_SEARCH.");
		return;
	}
	console.log(`Fetching ${uids.length} order(s) from orderbook...\n`);

	// 2. Fetch full order details; keep only sell orders that are not partial fills
	const allOrders = await Promise.all(uids.map(fetchOrder));
	const orders = allOrders.filter(
		(o): o is Order =>
			o !== null && o.kind === "sell" && !o.partiallyFillable && BigInt(o.executedSellAmount) > 0n,
	);
	console.log(`${orders.length} eligible order(s) (sell, not partial, executed)\n`);
	if (orders.length === 0) return;

	// 3. Fetch Binance quotes; discard orders with no SWAP route
	console.log("Fetching Binance quotes...");
	const quoted: Array<{ order: Order; binanceBuyAmount: bigint }> = [];
	for (const order of orders) {
		const binanceBuyAmount = await fetchBinanceQuote(
			order.sellToken,
			order.buyToken,
			BigInt(order.executedSellAmount),
		);
		if (binanceBuyAmount !== null) {
			quoted.push({ order, binanceBuyAmount });
		} else {
			console.log(`  No SWAP route for ${order.uid.slice(0, 20)}...`);
		}
	}
	console.log(`${quoted.length} order(s) with Binance SWAP routes\n`);
	if (quoted.length === 0) return;

	// 4. Fetch native prices for unique buy tokens (in parallel)
	console.log("Fetching native prices...");
	const uniqueBuyTokens = [...new Set(quoted.map((q) => q.order.buyToken.toLowerCase()))];
	const nativePrices = new Map<string, number>();
	await Promise.all(
		uniqueBuyTokens.map(async (token) => {
			const price = await fetchNativePrice(token);
			if (price !== null) nativePrices.set(token, price);
		}),
	);

	// 5. Get all token symbols via a single multicall
	console.log("Fetching token symbols via multicall...");
	const allTokens = [
		...new Set([
			...quoted.map((q) => q.order.sellToken.toLowerCase()),
			...quoted.map((q) => q.order.buyToken.toLowerCase()),
		]),
	];
	const symbols = await getTokenSymbols(allTokens);

	// 6. Calculate scores and sort descending
	const sym = (token: string) =>
		symbols.get(token.toLowerCase()) ?? token.slice(2, 8).toUpperCase();

	const scored = quoted
		.filter(({ order }) => nativePrices.has(order.buyToken.toLowerCase()))
		.map(({ order, binanceBuyAmount }) => {
			const price = nativePrices.get(order.buyToken.toLowerCase()) ?? 0;
			const gasCost = order.gasCost ? BigInt(order.gasCost) : 0n;
			const score = calculateScore(
				binanceBuyAmount,
				BigInt(order.executedBuyAmount),
				gasCost,
				price,
			);
			return { order, score };
		})
		.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0));

	// 7. Display results
	console.log("\n=== Results (ranked by score, best first) ===\n");
	if (scored.length === 0) {
		console.log("No results (native price unavailable for all buy tokens).");
		return;
	}
	for (const { order, score } of scored) {
		console.log(`Order UID:   ${order.uid}`);
		console.log(`Sell token:  ${sym(order.sellToken)}`);
		console.log(`Buy token:   ${sym(order.buyToken)}`);
		console.log(`Score:       ${score.toString()} (×10⁻²¹, i.e. ${Number(score) / 1e19}%)`);
		console.log();
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
});
