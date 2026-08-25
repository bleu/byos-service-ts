import { EscrowAbi } from "@byos/common";
import type { Address, PublicClient } from "viem";
import type { Proposal } from "../../domain/proposal.js";
import { ESCROW_GAS_ESTIMATION } from "../../domain/scoring.js";
import type { ValidateProposal, Verdict } from "../../domain/validator.js";

export interface GasPriceRef {
	value: bigint;
}

/**
 * Returns the `gasUsed` values for all in-flight proposals of a sub-solver,
 * excluding the proposal currently being validated. `null` means the proposal
 * has not been simulated yet (gas estimate unknown).
 */
export type FetchInflightGasUsed = (
	subSolver: Address,
	excludeId: number,
) => Promise<(bigint | null)[]>;

export class EscrowValidator implements ValidateProposal {
	private cache = new Map<string, bigint>();

	constructor(
		private readonly publicClient: PublicClient,
		private readonly escrowAddress: Address,
		private readonly minCollateral: bigint,
		private readonly gasPriceRef: GasPriceRef,
		private readonly fetchInflightGasUsed: FetchInflightGasUsed | null = null,
	) {}

	/**
	 * Per-proposal cost floor: conservative gas estimate × gas price + min collateral.
	 * Used both as the single-proposal gate and as each in-flight proposal's
	 * contribution when its gas estimate is unknown.
	 */
	private threshold(gasEstimate: bigint = ESCROW_GAS_ESTIMATION): bigint {
		return gasEstimate * this.gasPriceRef.value + this.minCollateral;
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

	/**
	 * Computes the cumulative exposure for all in-flight proposals of a
	 * sub-solver (excluding the one being validated).
	 * Each proposal contributes: gasEstimate * gasPrice + minCollateral.
	 * Proposals without a gas estimate contribute minCollateral only (gasEstimate = 0n).
	 */
	private async cumulativeExposure(subSolver: Address, excludeId: number): Promise<bigint> {
		if (!this.fetchInflightGasUsed) return 0n;
		const gasUsedList = await this.fetchInflightGasUsed(subSolver, excludeId);
		return gasUsedList.reduce((sum, gas) => sum + this.threshold(gas ?? 0n), 0n);
	}

	async validate(proposal: Proposal): Promise<Verdict | null> {
		try {
			const balance = await this.getBalance(proposal.subSolver);

			// Gate 1: the proposal alone must not exceed the balance floor.
			if (balance < this.threshold()) {
				return { kind: "reject", reason: "InsufficientEscrow" };
			}

			// Gate 2: adding this proposal's cost to all in-flight proposals must
			// not exceed the effective balance.
			const exposure = await this.cumulativeExposure(proposal.subSolver, proposal.id);
			if (exposure + this.threshold() > balance) {
				return { kind: "reject", reason: "ExposureCapExceeded" };
			}

			return { kind: "accept", simulation: null };
		} catch {
			// All RPC/DB errors → defer (retry next tick)
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
			// One request per call to this function, so BALANCE_REFRESH_BATCH_SIZE
			// is the real batch. viem otherwise re-chunks by encoded calldata
			// size (1024 bytes by default), which quietly splits a 50-address
			// batch into two round trips.
			batchSize: 0,
		});

		return results.map((r) => (r.status === "success" ? (r.result as bigint) : null));
	};
}
