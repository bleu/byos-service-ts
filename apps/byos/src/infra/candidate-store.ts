import type { ContractInteraction } from "@byos/common";
import { sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { Db } from "../db/index.js";

/** A validated proposal held in application memory, awaiting /solve selection. */
export interface Candidate {
	id: number;
	subSolver: Address;
	orderUid: string;
	orderUidHash: Hex;
	sellAmount: bigint;
	minBuyAmount: bigint;
	quoteBuyAmount: bigint;
	sellToken: Address;
	buyToken: Address;
	interactions: ContractInteraction[];
	interactionsHash: Hex;
	validUntil: bigint;
	nonce: bigint;
	signature: Hex;
	/** Auction this candidate was validated against. */
	auctionId: number;
	gasUsed: bigint;
	trampoline: Address;
	simulationBuyAmount: bigint | null;
	/** Sell token ref price at validation time — used for CIP-87 exposure. */
	sellTokenRefPrice: string;
	createdAt: Date;
}

export class CandidateStore {
	private readonly candidates = new Map<number, Candidate>();

	add(candidate: Candidate): void {
		this.candidates.set(candidate.id, candidate);
	}

	get(id: number): Candidate | undefined {
		return this.candidates.get(id);
	}

	remove(id: number): boolean {
		return this.candidates.delete(id);
	}

	removeAll(ids: number[]): void {
		for (const id of ids) this.candidates.delete(id);
	}

	/** Returns a copy of all candidates for the given auction. */
	snapshotForAuction(auctionId: number): Candidate[] {
		return [...this.candidates.values()].filter((c) => c.auctionId === auctionId);
	}

	/** Returns a candidate by id only if it belongs to the given sub-solver. */
	getForOwner(id: number, subSolver: Address): Candidate | undefined {
		const c = this.candidates.get(id);
		if (!c) return undefined;
		return c.subSolver.toLowerCase() === subSolver.toLowerCase() ? c : undefined;
	}

	getAll(): Candidate[] {
		return [...this.candidates.values()];
	}

	/** Allocates an ID from the proposals sequence without inserting a row. */
	static async allocateId(db: Db): Promise<number> {
		const rows = await db.execute(sql`SELECT nextval('proposals_id_seq') AS id`);
		const row = (rows as unknown as Array<{ id: string | bigint }>)[0];
		if (!row) throw new Error("failed to allocate proposal ID");
		return Number(row.id);
	}
}
