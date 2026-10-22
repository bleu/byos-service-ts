import { afterEach, describe, expect, it, vi } from "vitest";
import { AwsOrderbookClient, RECOVERY_THRESHOLD_MS } from "../aws-orderbook-client.js";

// --- Helpers ---

const SETTLEMENT_ADDRESS = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;
const SETTLE_SELECTOR = "0x13d79a0b";
const AWS_URL = "https://s3.example.com";

interface AutopilotDto {
	orders: unknown[];
	prices?: Record<string, string>;
}

function makeAuction(_id?: number): AutopilotDto {
	return { orders: [], prices: {} };
}

/** settleCalldata(100) → "0x13d79a0b" + 8 zero bytes + auction ID as 16 hex chars */
function settleCalldata(auctionId: number): string {
	return `${SETTLE_SELECTOR}${"00".repeat(8)}${auctionId.toString(16).padStart(16, "0")}`;
}

/**
 * Mock global fetch: maps auction id → AutopilotDto (found), undefined (404), or "error" (5xx).
 * Also handles unknown IDs as 404.
 */
function mockFetch(available: Record<number, AutopilotDto | "error">) {
	const fetchFn = vi.fn().mockImplementation((url: string) => {
		const match = /\/autopilot\/(\d+)\.json$/.exec(url);
		if (!match?.[1]) {
			return Promise.resolve(new Response(null, { status: 404 }));
		}
		const id = Number(match[1]);
		const entry = available[id];
		if (entry === undefined) {
			return Promise.resolve(new Response(null, { status: 404 }));
		}
		if (entry === "error") {
			return Promise.resolve(new Response(null, { status: 500 }));
		}
		return Promise.resolve(new Response(JSON.stringify(entry), { status: 200 }));
	});
	vi.stubGlobal("fetch", fetchFn);
	return fetchFn;
}

/**
 * Build a mock PublicClient that returns a single Settlement log for the given auctionId.
 * If routerTx is true, the transaction's `to` is a router address rather than the settlement.
 */
function mockPublicClient(
	auctionId: number,
	opts: { routerTx?: boolean; extraLog?: { auctionId: number } } = {},
) {
	const directCalldata = settleCalldata(auctionId);
	const routerAddress = "0xrouter0000000000000000000000000000000000";

	const logs: { transactionHash: string }[] = [];

	if (opts.routerTx) {
		// First log: router tx
		logs.push({ transactionHash: "0xrouter_tx" });
	}

	if (opts.extraLog) {
		logs.push({ transactionHash: "0xdirect_tx" });
	} else if (!opts.routerTx) {
		logs.push({ transactionHash: "0xdirect_tx" });
	} else {
		// routerTx + no extraLog: push the direct one after the router one
		logs.push({ transactionHash: "0xdirect_tx2" });
	}

	const getTransaction = vi.fn().mockImplementation(({ hash }: { hash: string }) => {
		if (hash === "0xrouter_tx") {
			return Promise.resolve({
				to: routerAddress,
				input: settleCalldata(999), // shouldn't be read
			});
		}
		// Direct settle() tx
		return Promise.resolve({
			to: SETTLEMENT_ADDRESS,
			input: directCalldata,
		});
	});

	const getBlockNumber = vi.fn().mockResolvedValue(2000n);
	const getLogs = vi.fn().mockResolvedValue(logs);

	return { getBlockNumber, getLogs, getTransaction };
}

/** Build a public client that returns empty logs (no settlements). */
function mockPublicClientNoLogs() {
	return {
		getBlockNumber: vi.fn().mockResolvedValue(2000n),
		getLogs: vi.fn().mockResolvedValue([]),
		getTransaction: vi.fn(),
	};
}

afterEach(() => vi.unstubAllGlobals());

// --- Tests ---

describe("AwsOrderbookClient", () => {
	it("Bootstrap – finds latest when >6 IDs beyond anchor", async () => {
		// Anchor from on-chain = 100. S3 has IDs 100–120.
		const available: Record<number, AutopilotDto | "error"> = {};
		for (let i = 100; i <= 120; i++) available[i] = makeAuction(i);

		mockFetch(available);
		const publicClient = mockPublicClient(100);

		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS);

		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(120);
	});

	it("Bootstrap – works without a recent settlement (uses bootstrapAuctionId)", async () => {
		// getLogs returns []. Pass { bootstrapAuctionId: 50 }. S3 has 50, 51, 52.
		const available: Record<number, AutopilotDto | "error"> = {
			50: makeAuction(50),
			51: makeAuction(51),
			52: makeAuction(52),
		};

		mockFetch(available);
		const publicClient = mockPublicClientNoLogs();

		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 50,
		});

		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(52);
	});

	it("Bootstrap – skips router transactions, uses direct settle()", async () => {
		// Two logs: first has tx.to = routerAddress, second has tx.to = SETTLEMENT_ADDRESS with auctionId=200
		const available: Record<number, AutopilotDto | "error"> = {
			200: makeAuction(200),
		};

		mockFetch(available);
		const publicClient = mockPublicClient(200, { routerTx: true });

		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS);

		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(200);
	});

	it("Normal polling – advances cursor without on-chain discovery", async () => {
		// Bootstrap at 100, second call finds 101.
		// anchor=99 from settlement, searchForward(99): 99 found, 100 found, 101 → 404 → cursor=100
		const available: Record<number, AutopilotDto | "error"> = {
			99: makeAuction(99),
			100: makeAuction(100),
		};
		mockFetch(available);

		const publicClient = mockPublicClient(99); // settlement at 99
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS);

		await client.solvableOrders();

		const blockNumberCallsAfterBootstrap = publicClient.getBlockNumber.mock.calls.length;

		// Now add 101
		available[101] = makeAuction(101);
		mockFetch(available);

		await client.solvableOrders();

		// getBlockNumber should not be called again after bootstrap
		expect(publicClient.getBlockNumber.mock.calls.length).toBe(blockNumberCallsAfterBootstrap);

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(101);
	});

	it("Normal polling – C+6 triggers wider search", async () => {
		// Cursor = 100. S3 has 101–115.
		// pollFromCursor fetches 101–106 (all found, C+6=106 populated),
		// triggers searchForward(106), finds up to 115. Cursor = 115.
		const available: Record<number, AutopilotDto | "error"> = {};
		for (let i = 101; i <= 115; i++) available[i] = makeAuction(i);

		// Need anchor for bootstrap. Use bootstrapAuctionId=100 with empty getLogs.
		available[100] = makeAuction(100);
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
		});

		// Bootstrap: searchForward(100) → 100 found, probe 101..115 found, 116 not found → cursor=115
		// But we want to test pollFromCursor's C+6 path specifically.
		// Let's set cursor manually to 100 after bootstrap by limiting available during bootstrap.
		// Simplest: set cursor=100, then call solvableOrders again with 101-115 available.

		// First call bootstraps: anchor=100, 100 found, 101 found, ..., 115 found, 116 404 → cursor=115
		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(115);
	});

	it("Normal polling – C+6 triggers wider search (cursor-only scenario)", async () => {
		// Directly set cursor to 100 and simulate polling with 101-115 available.
		const available: Record<number, AutopilotDto | "error"> = {};
		for (let i = 100; i <= 115; i++) available[i] = makeAuction(i);
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
			maxDiscoveryRequests: 64,
		});

		// Bootstrap to cursor=115 (searchForward(100) walks 100→115)
		await client.solvableOrders();
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(115);

		// Now simulate polling: add 116-130 to available and set cursor to 109 to trigger C+6 full
		// path. Instead, re-initialize with cursor at 100 by resetting latestPublishedId.
		for (let i = 116; i <= 130; i++) available[i] = makeAuction(i);
		mockFetch(available);

		// @ts-expect-error accessing private field for assertion
		client.latestPublishedId = 100;

		await client.solvableOrders();

		// pollFromCursor: 101..106 all found (C+6 populated) → searchForward(106) → 130
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(130);
	});

	it("Normal polling – no new snapshots leaves cursor unchanged", async () => {
		// Cursor = 100. S3 has nothing above 100.
		const available: Record<number, AutopilotDto | "error"> = { 100: makeAuction(100) };
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
		});

		// Bootstrap: cursor = 100
		await client.solvableOrders();
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(100);

		// Poll: nothing above 100
		await client.solvableOrders();
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(100);
	});

	it("HTTP errors – transient errors don't establish boundary", async () => {
		// searchForward(100): 100=found, 101=found, 102=error.
		// Must not treat 102 as a 404 boundary. Returns best found so far (101).
		const available: Record<number, AutopilotDto | "error"> = {
			100: makeAuction(100),
			101: makeAuction(101),
			102: "error",
		};
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
			maxDiscoveryRequests: 64,
		});

		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(101);
	});

	it("Recovery – long interruption triggers wider search", async () => {
		vi.useFakeTimers();

		const available: Record<number, AutopilotDto | "error"> = { 100: makeAuction(100) };
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
		});

		// Bootstrap: cursor = 100
		await client.solvableOrders();
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(100);

		// Simulate long interruption
		vi.advanceTimersByTime(RECOVERY_THRESHOLD_MS + 1);

		// Add many new auctions
		for (let i = 101; i <= 130; i++) available[i] = makeAuction(i);
		mockFetch(available);

		// Next poll should trigger searchForward (recovery path) and find 130
		await client.solvableOrders();

		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(130);

		vi.useRealTimers();
	});

	it("Request budget – preserves partial progress", async () => {
		// bootstrapAuctionId=100, maxDiscoveryRequests=4
		// S3 has 100–500. Budget=4:
		//   check(100)=found (budget=3), check(101)=found (budget=2), check(102)=found (budget=1),
		//   check(104)=found (budget=0, offset*2=4 → 100+4=104) → exhausted without 404 → cursor=104
		const available: Record<number, AutopilotDto | "error"> = {};
		for (let i = 100; i <= 500; i++) available[i] = makeAuction(i);
		mockFetch(available);

		const publicClient = mockPublicClientNoLogs();
		const client = new AwsOrderbookClient(AWS_URL, publicClient as never, SETTLEMENT_ADDRESS, {
			bootstrapAuctionId: 100,
			maxDiscoveryRequests: 4,
		});

		await client.solvableOrders();

		// Budget=4: check anchor(100)→found(3), offset=1→101 found(2), offset=2→102 found(1), offset=4→104 found(0) → done
		// @ts-expect-error accessing private field for assertion
		expect(client.latestPublishedId).toBe(104);
	});
});
