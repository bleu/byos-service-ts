import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createBatchedEscrowBalanceReader } from "../escrow.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const addresses = Array.from(
	{ length: 3 },
	(_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

describe("batched validation escrow reads", () => {
	it("combines concurrent addresses into one explicit multicall", async () => {
		const batches: unknown[][] = [];
		const client = {
			multicall: async ({ contracts }: { contracts: unknown[] }) => {
				batches.push(contracts);
				return contracts.map((_, i) => ({ status: "success", result: BigInt(i) }));
			},
		} as unknown as PublicClient;
		const read = createBatchedEscrowBalanceReader(client, ESCROW, { waitMs: 0 });
		expect(await Promise.all(addresses.map(read))).toEqual([0n, 1n, 2n]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
	});
	it("isolates a failed address and retries later reads", async () => {
		let calls = 0;
		const client = {
			multicall: async () => {
				calls++;
				return calls === 1
					? [{ status: "failure" }, { status: "success", result: 12n }]
					: [{ status: "success", result: 14n }];
			},
		} as unknown as PublicClient;
		const read = createBatchedEscrowBalanceReader(client, ESCROW, { waitMs: 0 });
		const results = await Promise.allSettled([read(addresses[0]!), read(addresses[1]!)]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]).toEqual({ status: "fulfilled", value: 12n });
		expect(await read(addresses[0]!)).toBe(14n);
	});
	it("bounds multicall size and rejects all affected reads on transport errors", async () => {
		const sizes: number[] = [];
		const client = {
			multicall: async ({ contracts }: { contracts: unknown[] }) => {
				sizes.push(contracts.length);
				throw new Error("RPC unavailable");
			},
		} as unknown as PublicClient;
		const read = createBatchedEscrowBalanceReader(client, ESCROW, { waitMs: 0, batchSize: 2 });
		const results = await Promise.allSettled(addresses.map(read));
		expect(sizes).toEqual([2, 1]);
		expect(results.every((result) => result.status === "rejected")).toBe(true);
	});
});
