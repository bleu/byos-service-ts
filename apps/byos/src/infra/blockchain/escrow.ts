import { setTimeout as delay } from "node:timers/promises";
import { EscrowAbi } from "@byos/common";
import type { Address, PublicClient } from "viem";
import type { Proposal } from "../../domain/proposal.js";
import type { ValidateProposal, Verdict } from "../../domain/validator.js";

export interface GasPriceRef {
	value: bigint;
}

export class EscrowValidator implements ValidateProposal {
	private cache = new Map<string, Promise<bigint>>();
	private readonly readBalance: (subSolver: Address) => Promise<bigint>;

	constructor(
		publicClient: PublicClient,
		escrowAddress: Address,
		private readonly minCollateral: bigint,
	) {
		this.readBalance = createBatchedEscrowBalanceReader(publicClient, escrowAddress);
	}

	beginTick(): void {
		this.cache.clear();
	}

	/** One authoritative read per address per tick, including concurrent callers. */
	async getBalance(subSolver: Address): Promise<bigint> {
		const key = subSolver.toLowerCase();
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;

		const balance = this.readBalance(subSolver).catch((error: unknown) => {
			if (this.cache.get(key) === balance) this.cache.delete(key);
			throw error;
		});

		this.cache.set(key, balance);
		return balance;
	}

	async validate(proposal: Proposal): Promise<Verdict | null> {
		try {
			const balance = await this.getBalance(proposal.subSolver);

			// Gate 1: the sub-solver must hold at least MIN_COLLATERAL.
			if (balance < this.minCollateral) {
				return { kind: "reject", reason: "InsufficientEscrow" };
			}

			return { kind: "accept", simulation: null };
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
			// One request per call to this function, so BALANCE_REFRESH_BATCH_SIZE
			// is the real batch. viem otherwise re-chunks by encoded calldata
			// size (1024 bytes by default), which quietly splits a 50-address
			// batch into two round trips.
			batchSize: 0,
		});

		return results.map((r) => (r.status === "success" ? (r.result as bigint) : null));
	};
}

/**
 * Collect independent validation reads into bounded, explicit multicalls.
 * This one-shot RPC collection window is not a background job scheduler.
 * Per-tick caching and address deduplication belong to EscrowValidator.
 */
export function createBatchedEscrowBalanceReader(
	publicClient: PublicClient,
	escrowAddress: Address,
	{ waitMs = 100, batchSize = 50 }: { waitMs?: number; batchSize?: number } = {},
): (address: Address) => Promise<bigint> {
	const readBatch = createEscrowBalanceReader(publicClient, escrowAddress);
	let pending: {
		address: Address;
		resolve: (balance: bigint) => void;
		reject: (error: unknown) => void;
	}[] = [];
	let scheduled = false;

	const flush = async () => {
		const requests = pending;
		pending = [];
		scheduled = false;
		for (let offset = 0; offset < requests.length; offset += batchSize) {
			const batch = requests.slice(offset, offset + batchSize);
			try {
				const balances = await readBatch(batch.map((request) => request.address));
				for (const [index, request] of batch.entries()) {
					const balance = balances[index];
					if (balance == null) request.reject(new Error("Escrow balance unavailable"));
					else request.resolve(balance);
				}
			} catch (error) {
				for (const request of batch) request.reject(error);
			}
		}
	};

	return (address) =>
		new Promise<bigint>((resolve, reject) => {
			pending.push({ address, resolve, reject });
			if (!scheduled) {
				scheduled = true;
				void delay(waitMs).then(flush);
			}
		});
}
