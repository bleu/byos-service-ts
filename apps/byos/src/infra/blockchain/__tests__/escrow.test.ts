import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../domain/proposal.js";
import { EscrowValidator } from "../escrow.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const MIN_COLLATERAL = 10_000_000_000_000_000n; // 0.01 ETH

function submittedProposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
		orderUid: `0x${"aa".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}`,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}`,
		validUntil: 1_700_000_000n,
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}`,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
		simulationFailureParams: null,
		createdAt: new Date(0),
		statusChangedAt: new Date(0),
		sellTokenRefPrice: null,
		surplusTokenRefPrice: null,
		auctionGasPrice: null,
		clearingPrices: null,
		...overrides,
	} as Proposal;
}

/** A client whose multicall returns `balance`, counting batches. */
function clientWithBalance(balance: bigint): PublicClient & { calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		multicall: async () => {
			calls += 1;
			return [{ status: "success", result: balance }];
		},
	} as unknown as PublicClient & { calls: () => number };
}

function validatorWith(client: PublicClient): EscrowValidator {
	return new EscrowValidator(client, ESCROW, MIN_COLLATERAL);
}

describe("EscrowValidator — floor gate (single proposal)", () => {
	it("accepts when balance equals min collateral", async () => {
		const verdict = await validatorWith(clientWithBalance(MIN_COLLATERAL)).validate(
			submittedProposal(),
		);
		expect(verdict).toEqual({ kind: "accept", simulation: null });
	});

	it("rejects when balance is below min collateral", async () => {
		const verdict = await validatorWith(clientWithBalance(MIN_COLLATERAL - 1n)).validate(
			submittedProposal(),
		);
		expect(verdict).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});

	it("balance reads are cached within a tick and cleared by beginAuction", async () => {
		const client = clientWithBalance(MIN_COLLATERAL);
		const validator = validatorWith(client);

		await validator.validate(submittedProposal());
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(1);

		validator.beginAuction();
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(2);
	});

	it("beginAuction on a fresh validator is a noop", async () => {
		const client = clientWithBalance(MIN_COLLATERAL);
		const validator = validatorWith(client);

		validator.beginAuction();

		const verdict = await validator.validate(submittedProposal());
		expect(verdict).toEqual({ kind: "accept", simulation: null });
	});

	it("transport error defers judgment", async () => {
		const failing = {
			multicall: async () => {
				throw new Error("connection refused");
			},
		} as unknown as PublicClient;

		const verdict = await validatorWith(failing).validate(submittedProposal());
		expect(verdict).toBeNull();
	});
});

describe("shared authoritative balance snapshot", () => {
	it("coalesces concurrent reads, shares between gates, and refreshes next tick", async () => {
		const client = clientWithBalance(MIN_COLLATERAL);
		const validator = validatorWith(client);
		await Promise.all([
			validator.getBalance(submittedProposal().subSolver),
			validator.getBalance(submittedProposal().subSolver),
		]);
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(1);
		validator.beginAuction();
		await validator.getBalance(submittedProposal().subSolver);
		expect(client.calls()).toBe(2);
	});
	it("evicts failed reads so a transient failure can recover within the tick", async () => {
		let calls = 0;
		const client = {
			multicall: async () => {
				calls++;
				if (calls === 1) throw new Error("RPC timeout");
				return [{ status: "success", result: MIN_COLLATERAL }];
			},
		} as unknown as PublicClient;
		const validator = validatorWith(client);
		expect(await validator.validate(submittedProposal())).toBeNull();
		expect((await validator.validate(submittedProposal()))?.kind).toBe("accept");
		expect(calls).toBe(2);
	});
});
