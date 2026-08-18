import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createEscrowBalanceReader } from "../escrow.js";

const ESCROW = "0x00000000000000000000000000000000000000ee" as Address;
const A = "0xAaA1111111111111111111111111111111111111" as Address;
const B = "0xBbB2222222222222222222222222222222222222" as Address;

/** A client whose multicall answers from a script, recording the calls. */
function clientReturning(
	results: { status: "success" | "failure"; result?: bigint }[],
): PublicClient & { contracts: unknown[][] } {
	const contracts: unknown[][] = [];
	return {
		contracts,
		multicall: async ({ contracts: batch }: { contracts: unknown[] }) => {
			contracts.push(batch);
			return results;
		},
	} as unknown as PublicClient & { contracts: unknown[][] };
}

describe("escrow balance reader", () => {
	it("reads a batch of balances in one multicall", async () => {
		const client = clientReturning([
			{ status: "success", result: 10n },
			{ status: "success", result: 20n },
		]);
		const read = createEscrowBalanceReader(client, ESCROW);

		await expect(read([A, B])).resolves.toEqual([10n, 20n]);
		expect(client.contracts).toHaveLength(1);
	});

	it("reports a failed read as no answer, never as a zero balance", async () => {
		// A zero here would demote a funded sub-solver to the negative set on
		// a dropped RPC call — the one error direction that cannot be tolerated.
		const client = clientReturning([{ status: "failure" }, { status: "success", result: 20n }]);
		const read = createEscrowBalanceReader(client, ESCROW);

		await expect(read([A, B])).resolves.toEqual([null, 20n]);
	});
});
