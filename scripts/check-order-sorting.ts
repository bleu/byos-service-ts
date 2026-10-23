/**
 * Checks whether orders in an auction snapshot are sorted by estimatedNativeSurplus descending.
 * estimatedNativeSurplus = (buyAmount * buyTokenReferencePrice - sellAmount * sellTokenReferencePrice) / 1e18
 *
 * Usage:
 *   npx ts-node scripts/check-order-sorting.ts [auction-json-url]
 *
 * Defaults to auction 26542932 if no URL is provided.
 */

const DEFAULT_URL =
	"https://solver-instances.s3.eu-central-1.amazonaws.com/prod/bnb/auction/26542932.json";

interface Token {
	decimals: number;
	symbol: string;
	referencePrice: string;
	availableBalance?: string;
	trusted?: boolean;
}

interface Order {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	validTo: number;
	kind: string;
	partiallyFillable?: boolean;
}

interface AuctionSnapshot {
	id: number;
	tokens: Record<string, Token>;
	orders: Order[];
}

function nativeValue(amount: bigint, referencePrice: bigint): bigint {
	return (amount * referencePrice) / BigInt(1e18);
}

function estimatedNativeSurplus(order: Order, tokens: Record<string, Token>): bigint | null {
	const buyToken = tokens[order.buyToken];
	const sellToken = tokens[order.sellToken];
	if (!buyToken?.referencePrice || !sellToken?.referencePrice) return null;

	const buyValue = nativeValue(BigInt(order.buyAmount), BigInt(buyToken.referencePrice));
	const sellValue = nativeValue(BigInt(order.sellAmount), BigInt(sellToken.referencePrice));
	return buyValue - sellValue;
}

function formatSurplus(surplus: bigint): string {
	const n = Number(surplus) / 1e18;
	return `${n.toFixed(6)} ETH-equiv`;
}

async function main() {
	const url = process.argv[2] ?? DEFAULT_URL;
	console.log(`Fetching: ${url}\n`);

	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
	const snapshot: AuctionSnapshot = await res.json();

	console.log(`Auction ID: ${snapshot.id}`);
	console.log(`Orders: ${snapshot.orders.length}`);
	console.log(`Tokens: ${Object.keys(snapshot.tokens).length}\n`);

	const scored = snapshot.orders.map((order, idx) => {
		const surplus = estimatedNativeSurplus(order, snapshot.tokens);
		return { idx, order, surplus };
	});

	// Print each order's surplus in original order
	console.log("=== Orders in original order ===");
	console.log(
		`${"#".padStart(4)}  ${"surplus".padStart(20)}  ${"kind".padEnd(4)}  ${"uid".substring(0, 10)}...`,
	);
	for (const { idx, order, surplus } of scored) {
		const surplusStr =
			surplus === null ? "         (no price)" : formatSurplus(surplus).padStart(20);
		console.log(
			`${String(idx).padStart(4)}  ${surplusStr}  ${order.kind.padEnd(4)}  ${order.uid.slice(0, 12)}...`,
		);
	}

	// Check sortedness
	const withSurplus = scored.filter((s) => s.surplus !== null) as {
		idx: number;
		order: Order;
		surplus: bigint;
	}[];

	let violations = 0;
	for (let i = 0; i < withSurplus.length - 1; i++) {
		if (withSurplus[i].surplus < withSurplus[i + 1].surplus) {
			violations++;
			console.log(
				`\nVIOLATION at positions ${withSurplus[i].idx} → ${withSurplus[i + 1].idx}: ` +
					`${formatSurplus(withSurplus[i].surplus)} < ${formatSurplus(withSurplus[i + 1].surplus)}`,
			);
		}
	}

	console.log("\n=== Sorted by surplus descending (expected order) ===");
	const sorted = [...withSurplus].sort((a, b) =>
		a.surplus > b.surplus ? -1 : a.surplus < b.surplus ? 1 : 0,
	);
	console.log(`${"rank".padStart(4)}  ${"orig#".padStart(5)}  ${"surplus".padStart(20)}  uid`);
	for (let i = 0; i < sorted.length; i++) {
		const { idx, order, surplus } = sorted[i];
		console.log(
			`${String(i + 1).padStart(4)}  ${String(idx).padStart(5)}  ${formatSurplus(surplus).padStart(20)}  ${order.uid.slice(0, 20)}...`,
		);
	}

	console.log(`\n--- Result ---`);
	if (violations === 0) {
		console.log(
			`SORTED: all ${withSurplus.length} orders with prices are in descending surplus order.`,
		);
	} else {
		console.log(
			`NOT SORTED: ${violations} violation(s) found out of ${withSurplus.length} scoreable orders.`,
		);
	}

	const noPrice = scored.length - withSurplus.length;
	if (noPrice > 0) {
		console.log(`(${noPrice} order(s) skipped — missing token reference price)`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
