import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../domain/proposal.js";
import { EscrowValidator } from "../escrow.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const MIN_COLLATERAL = 10_000_000_000_000_000n; // 0.01 ETH
const GAS_PRICE = 20_000_000_000n; // 20 gwei
// 200_000 gas × 20 gwei + 0.01 ETH = 0.004 ETH + 0.01 ETH
const THRESHOLD = 14_000_000_000_000_000n;

function submittedProposal(): Proposal {
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
	};
}

/** A client whose effectiveBalance read returns `balance`, counting calls. */
function clientWithBalance(balance: bigint): PublicClient & { calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		readContract: async () => {
			calls += 1;
			return balance;
		},
	} as unknown as PublicClient & { calls: () => number };
}

function validatorWith(client: PublicClient, gasPrice = GAS_PRICE): EscrowValidator {
	return new EscrowValidator(client, ESCROW, MIN_COLLATERAL, { value: gasPrice });
}

describe("EscrowValidator", () => {
	it("threshold is gas estimate times price plus collateral", async () => {
		// Balance exactly at the threshold passes; one wei below fails.
		const atThreshold = await validatorWith(clientWithBalance(THRESHOLD)).validate(
			submittedProposal(),
		);
		expect(atThreshold).toEqual({ kind: "accept", simulation: null });

		const below = await validatorWith(clientWithBalance(THRESHOLD - 1n)).validate(
			submittedProposal(),
		);
		expect(below).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});

	it("threshold with zero gas price equals min collateral", async () => {
		const atCollateral = await validatorWith(clientWithBalance(MIN_COLLATERAL), 0n).validate(
			submittedProposal(),
		);
		expect(atCollateral).toEqual({ kind: "accept", simulation: null });

		const below = await validatorWith(clientWithBalance(MIN_COLLATERAL - 1n), 0n).validate(
			submittedProposal(),
		);
		expect(below).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});

	it("balance reads are cached within a tick and cleared by beginTick", async () => {
		const client = clientWithBalance(THRESHOLD);
		const validator = validatorWith(client);

		await validator.validate(submittedProposal());
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(1);

		validator.beginTick();
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(2);
	});

	it("beginTick on a fresh validator is a noop", async () => {
		const client = clientWithBalance(THRESHOLD);
		const validator = validatorWith(client);

		validator.beginTick();

		const verdict = await validator.validate(submittedProposal());
		expect(verdict).toEqual({ kind: "accept", simulation: null });
	});

	it("transport error defers judgment", async () => {
		const failing = {
			readContract: async () => {
				throw new Error("connection refused");
			},
		} as unknown as PublicClient;

		const verdict = await validatorWith(failing).validate(submittedProposal());
		expect(verdict).toBeNull();
	});
});
