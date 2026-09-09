import { EscrowAbi } from "@byos/common";
import { type Address, createPublicClient, http, parseEther } from "viem";

// Varied mocked escrow balances for local development (USE_MOCKED_DATA=true).
const MOCK_BALANCES = [parseEther("2.5"), parseEther("0.8"), parseEther("5.1")];

/**
 * Fetches the effectiveBalance from the escrow contract for each address in
 * one multicall round trip. Returns null for addresses where the call failed.
 *
 * When USE_MOCKED_DATA=true, returns deterministic fake balances so local dev
 * works without RPC_URL / ESCROW_ADDRESS.
 */
export async function getEscrowBalances(
	addresses: Address[],
): Promise<Map<Address, bigint | null>> {
	if (addresses.length === 0) return new Map();

	if (process.env.USE_MOCKED_DATA === "true") {
		return new Map(
			addresses.map((addr, i) => [addr, MOCK_BALANCES[i % MOCK_BALANCES.length] ?? null]),
		);
	}

	const rpcUrl = process.env.RPC_URL;
	const escrowAddress = process.env.ESCROW_ADDRESS;
	if (!rpcUrl || !escrowAddress) {
		throw new Error("RPC_URL and ESCROW_ADDRESS env vars are required");
	}

	const client = createPublicClient({ transport: http(rpcUrl) });

	const results = await client.multicall({
		contracts: addresses.map((address) => ({
			address: escrowAddress as Address,
			abi: EscrowAbi,
			functionName: "effectiveBalance",
			args: [address],
		})),
		batchSize: 0,
	});

	const map = new Map<Address, bigint | null>();
	for (const [i, result] of results.entries()) {
		const address = addresses[i];
		if (address !== undefined) {
			map.set(address, result.status === "success" ? (result.result as bigint) : null);
		}
	}
	return map;
}
