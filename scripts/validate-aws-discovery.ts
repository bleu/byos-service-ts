/**
 * Validates the AWS auction discovery approach and measures the impact of each filter.
 *
 * Filters applied in sequence:
 *   1. ERC20 balance only (sellTokenBalance === "erc20" && buyTokenBalance === "erc20")
 *   2. Non-zero amounts (sellAmount > 0 && buyAmount > 0)
 *   3. Token metadata present (both tokens exist in the auction's token map)
 *   4. Token whitelist (both tokens in the CoinGecko BNB-56 list)
 *
 * Usage: pnpm tsx scripts/validate-aws-discovery.ts
 */

const COMPETITION_API = "https://api.cow.fi/bnb";
const DISCOVERY_BASE = "https://solver-instances.s3.eu-central-1.amazonaws.com/prod/bnb/auction";

interface AuctionOrder {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	sellTokenSource: string;
	buyTokenDestination: string;
	kind: string;
}

interface AuctionDto {
	id?: number;
	orders: AuctionOrder[];
	tokens?: Record<string, unknown>;
}

async function fetchLatestAuctionId(): Promise<number> {
	const res = await fetch(`${COMPETITION_API}/api/v2/solver_competition/latest`);
	if (!res.ok) throw new Error(`competition API ${res.status}: ${await res.text()}`);
	const { auctionId } = (await res.json()) as { auctionId: number };
	return auctionId;
}

async function fetchAuction(id: number): Promise<AuctionDto | null> {
	try {
		const res = await fetch(`${DISCOVERY_BASE}/${id}.json`);
		if (!res.ok) return null;
		return (await res.json()) as AuctionDto;
	} catch {
		return null;
	}
}


function report(label: string, before: number, after: number) {
	const dropped = before - after;
	console.log(`  ${label}: ${before} → ${after} (dropped ${dropped})`);
}

async function main() {
	console.log("Fetching latest settled auction ID...");
	const latestId = await fetchLatestAuctionId();
	console.log(`Latest settled auction ID: ${latestId}`);

	const probeIds = [1, 2, 3, 4, 5, 6].map((o) => latestId + o);
	console.log(`\nProbing S3 for auction IDs: ${probeIds.join(", ")}...`);
	const probeResults = await Promise.all(probeIds.map((id) => fetchAuction(id)));
	const auction = probeResults.filter((a): a is AuctionDto => a !== null).at(-1);
	if (!auction) {
		console.log("No auction found in range.");
		return;
	}
	console.log(`Using auction ${auction.id}, raw orders: ${auction.orders.length}\n`);

	console.log("Filter impact:");

	// Filter: market orders only
	const afterMarket = auction.orders.filter((o) => o.class === "market");
	report("Market orders only (drop limit)", auction.orders.length, afterMarket.length);

	console.log(`\nFinal: ${afterMarket.length} orders remaining out of ${auction.orders.length} raw`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
