import { TrampolineFactoryAbi } from "@byos/common";
import type { Address, PublicClient } from "viem";

/** Query for fetching Uniswap V2 pair reserves. */
export interface ReservesQuery {
	pair: Address;
	sellToken: Address;
	buyToken: Address;
}

/** Uniswap V2 pair getReserves() ABI. */
const pairAbi = [
	{
		type: "function",
		name: "getReserves",
		inputs: [],
		outputs: [
			{ name: "reserve0", type: "uint112" },
			{ name: "reserve1", type: "uint112" },
			{ name: "blockTimestampLast", type: "uint32" },
		],
		stateMutability: "view",
	},
] as const;

export class ChainClient {
	constructor(private readonly publicClient: PublicClient) {}

	/**
	 * Fetches reserves for multiple Uniswap V2 pairs in a single multicall.
	 * Returns (reserveSell, reserveBuy) for each query, or null if the call failed.
	 */
	async reserves(
		queries: ReservesQuery[],
	): Promise<Array<{ reserveSell: bigint; reserveBuy: bigint } | null>> {
		if (queries.length === 0) return [];

		const results = await this.publicClient.multicall({
			contracts: queries.map((q) => ({
				address: q.pair,
				abi: pairAbi,
				functionName: "getReserves" as const,
			})),
			allowFailure: true,
		});

		return results.map((result, i) => {
			if (result.status === "failure") return null;
			const [reserve0, reserve1] = result.result;
			const query = queries[i]!;

			// Reorient by trade direction: Uniswap V2 stores reserves by token address sort order
			if (query.sellToken.toLowerCase() < query.buyToken.toLowerCase()) {
				return { reserveSell: reserve0, reserveBuy: reserve1 };
			}
			return { reserveSell: reserve1, reserveBuy: reserve0 };
		});
	}

	/** Resolves the deterministic trampoline address for a sub-solver. */
	async trampoline(factory: Address, subSolver: Address): Promise<Address> {
		return this.publicClient.readContract({
			address: factory,
			abi: TrampolineFactoryAbi,
			functionName: "addressOf",
			args: [subSolver],
		});
	}
}
