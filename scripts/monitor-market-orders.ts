/**
 * Searches backwards through BNB auctions on S3 until an order expiring within 4000s is found.
 *
 * Starting from the latest settled auction ID, keeps fetching auction_id - 1,
 * auction_id - 2, etc. Skips IDs that return null/404.
 *
 * Usage: pnpm tsx scripts/monitor-market-orders.ts
 */

const COMPETITION_API = "https://api.cow.fi/bnb";
const DISCOVERY_BASE = "https://solver-instances.s3.eu-central-1.amazonaws.com/prod/bnb/autopilot";

interface AuctionOrder {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	kind: string;
	class: string;
	validTo: number;
	created: number;
}

interface AuctionDto {
	id?: number;
	orders: AuctionOrder[];
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

const BATCH_SIZE = 20;

async function main() {
	console.log("Fetching latest settled auction ID...");
	const latestId = await fetchLatestAuctionId();
	console.log(`Searching backwards from auction ID: ${latestId} (batches of ${BATCH_SIZE})\n`);

	let batchStart = latestId;
	let auctionsChecked = 0;

	while (batchStart > 0) {
		const ids = Array.from({ length: BATCH_SIZE }, (_, i) => batchStart - i).filter((id) => id > 0);
		const results = await Promise.all(ids.map((id) => fetchAuction(id).then((a) => ({ id, auction: a }))));

		for (const { id, auction } of results) {
			if (auction === null) {
				console.log(`[${id}] not found, skipping`);
				continue;
			}

			auctionsChecked++;
			const nowSecs = Math.floor(Date.now() / 1000);
			const freshOrders = auction.orders.filter(
				(o) => o.validTo <= nowSecs + 4000 && o.created >= nowSecs - 4000,
			);
			console.log(`[${id}] ${auction.orders.length} orders, ${freshOrders.length} fresh (validTo within 4000s + created within 4000s) (checked ${auctionsChecked} so far)`);

			if (freshOrders.length > 0) {
				console.log(`\nFound fresh order(s) in auction ${id} after checking ${auctionsChecked} auctions!`);
				for (const order of freshOrders) {
					console.log(JSON.stringify(order, null, 2));
				}
				return;
			}
		}

		batchStart -= BATCH_SIZE;
	}

	console.log(`No fresh orders found after checking ${auctionsChecked} auctions.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
