import { EscrowAbi } from "@byos/common";
import type { Address, PublicClient } from "viem";
import type { Proposal } from "../../domain/proposal.js";
import { ESCROW_GAS_ESTIMATION } from "../../domain/scoring.js";
import type { ValidateProposal, Verdict } from "../../domain/validator.js";

export interface GasPriceRef {
	value: bigint;
}

export class EscrowValidator implements ValidateProposal {
	private cache = new Map<string, bigint>();

	constructor(
		private readonly publicClient: PublicClient,
		private readonly escrowAddress: Address,
		private readonly minCollateral: bigint,
		private readonly gasPriceRef: GasPriceRef,
	) {}

	private threshold(): bigint {
		return ESCROW_GAS_ESTIMATION * this.gasPriceRef.value + this.minCollateral;
	}

	beginTick(): void {
		this.cache.clear();
	}

	private async getBalance(subSolver: Address): Promise<bigint> {
		const key = subSolver.toLowerCase();
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;

		const balance = await this.publicClient.readContract({
			address: this.escrowAddress,
			abi: EscrowAbi,
			functionName: "effectiveBalance",
			args: [subSolver],
		});

		this.cache.set(key, balance);
		return balance;
	}

	async validate(proposal: Proposal): Promise<Verdict | null> {
		try {
			const balance = await this.getBalance(proposal.subSolver);
			if (balance >= this.threshold()) {
				return { kind: "accept", simulation: null };
			}
			return { kind: "reject", reason: "InsufficientEscrow" };
		} catch {
			// All RPC errors → defer (retry next tick)
			return null;
		}
	}
}

/**
 * Batched `effectiveBalance` read for the request-path balance cache.
 *
 * A per-address failure comes back as `null`, not `0n`: the refresh job
 * files what it is told, and a zero would demote a funded sub-solver to the
 * negative set on nothing worse than a dropped RPC call.
 */
export function createEscrowBalanceReader(
	publicClient: PublicClient,
	escrowAddress: Address,
): (addresses: Address[]) => Promise<(bigint | null)[]> {
	return async (addresses) => {
		const results = await publicClient.multicall({
			contracts: addresses.map((address) => ({
				address: escrowAddress,
				abi: EscrowAbi,
				functionName: "effectiveBalance",
				args: [address],
			})),
		});

		return results.map((r) => (r.status === "success" ? (r.result as bigint) : null));
	};
}
