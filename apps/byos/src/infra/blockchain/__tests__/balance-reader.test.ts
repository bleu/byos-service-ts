import { evmChainFor } from "@byos/common";
import type { Address, PublicClient } from "viem";
import { createPublicClient, custom, http } from "viem";
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

/**
 * These drive viem's real `multicall`, not a stand-in for it. The stubbed
 * tests above cannot see whether the client is configured well enough to
 * resolve Multicall3 — a client without a chain throws before any request
 * leaves the process, which silently emptied the balance cache.
 */
describe("escrow balance reader on a real viem client", () => {
	it("answers nulls on an unreachable RPC instead of throwing", async () => {
		// The refresh job leaves a batch alone when the read fails, so the
		// reader must report no answer rather than blow up the tick.
		const client = createPublicClient({
			chain: evmChainFor(1),
			transport: http("http://127.0.0.1:1/dead"),
		});

		const read = createEscrowBalanceReader(client, ESCROW);
		await expect(read([A, B])).resolves.toEqual([null, null]);
	});

	it("sends one request per batch, so BALANCE_REFRESH_BATCH_SIZE is the real batch", async () => {
		// viem re-chunks by encoded calldata size (1024 bytes by default), which
		// splits 50 addresses into two round trips. The reads are allowed to
		// fail here — only the number of requests is under test.
		let calls = 0;
		const client = createPublicClient({
			chain: evmChainFor(1),
			// retryCount: 0 — the default 3 retries would count as extra calls.
			transport: custom(
				{
					async request({ method }: { method: string }) {
						if (method === "eth_call") {
							calls++;
							throw new Error("no node here");
						}
						if (method === "eth_chainId") return "0x1";
						throw new Error(`unexpected RPC method ${method}`);
					},
				},
				{ retryCount: 0 },
			),
		});

		const fifty = Array.from(
			{ length: 50 },
			(_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
		);

		await createEscrowBalanceReader(client, ESCROW)(fifty);

		expect(calls).toBe(1);
	});

	it("throws when the client has no chain, rather than failing quietly", async () => {
		// Without a chain viem cannot resolve Multicall3 and throws before
		// reaching the transport. The refresh job catches per batch and logs
		// at warn, so this failure is invisible in production: the cache
		// stays empty and every signer sits at the lowest tier forever.
		const client = createPublicClient({ transport: http("http://127.0.0.1:1/dead") });

		const read = createEscrowBalanceReader(client, ESCROW);
		await expect(read([A])).rejects.toThrow(/chain not configured/);
	});
});
