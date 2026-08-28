import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { Proposal } from "../../../domain/proposal.js";
import { EscrowValidator, type FetchInflightGasUsed } from "../escrow.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const MIN_COLLATERAL = 10_000_000_000_000_000n; // 0.01 ETH
const GAS_PRICE = 20_000_000_000n; // 20 gwei
// 200_000 gas × 20 gwei + 0.01 ETH = 0.004 ETH + 0.01 ETH
const THRESHOLD = 14_000_000_000_000_000n;

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
		...overrides,
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

/** No in-flight proposals for the sub-solver. */
const noInflight: FetchInflightGasUsed = async () => [];

function validatorWith(
	client: PublicClient,
	gasPrice = GAS_PRICE,
	fetchInflight: FetchInflightGasUsed | null = null,
): EscrowValidator {
	return new EscrowValidator(client, ESCROW, MIN_COLLATERAL, { value: gasPrice }, fetchInflight);
}

describe("EscrowValidator — floor gate (single proposal)", () => {
	it("threshold is gas estimate times price plus collateral", async () => {
		// Balance exactly at the threshold passes; one wei below fails.
		const atThreshold = await validatorWith(
			clientWithBalance(THRESHOLD),
			GAS_PRICE,
			noInflight,
		).validate(submittedProposal());
		expect(atThreshold).toEqual({ kind: "accept", simulation: null });

		const below = await validatorWith(
			clientWithBalance(THRESHOLD - 1n),
			GAS_PRICE,
			noInflight,
		).validate(submittedProposal());
		expect(below).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});

	it("threshold with zero gas price equals min collateral", async () => {
		const atCollateral = await validatorWith(
			clientWithBalance(MIN_COLLATERAL),
			0n,
			noInflight,
		).validate(submittedProposal());
		expect(atCollateral).toEqual({ kind: "accept", simulation: null });

		const below = await validatorWith(
			clientWithBalance(MIN_COLLATERAL - 1n),
			0n,
			noInflight,
		).validate(submittedProposal());
		expect(below).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});

	it("balance reads are cached within a tick and cleared by beginTick", async () => {
		const client = clientWithBalance(THRESHOLD);
		const validator = validatorWith(client, GAS_PRICE, noInflight);

		await validator.validate(submittedProposal());
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(1);

		validator.beginTick();
		await validator.validate(submittedProposal());
		expect(client.calls()).toBe(2);
	});

	it("beginTick on a fresh validator is a noop", async () => {
		const client = clientWithBalance(THRESHOLD);
		const validator = validatorWith(client, GAS_PRICE, noInflight);

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

		const verdict = await validatorWith(failing, GAS_PRICE, noInflight).validate(
			submittedProposal(),
		);
		expect(verdict).toBeNull();
	});

	it("no fetchInflightGasUsed wired → behaves as before (no exposure cap)", async () => {
		// Without a callback, EscrowValidator treats cumulative exposure as 0
		// and only applies the floor gate.
		const verdict = await validatorWith(clientWithBalance(THRESHOLD), GAS_PRICE, null).validate(
			submittedProposal(),
		);
		expect(verdict).toEqual({ kind: "accept", simulation: null });
	});
});

describe("EscrowValidator — cumulative exposure cap", () => {
	// With one in-flight proposal carrying the full gas estimate (200_000 gas),
	// the cumulative exposure before the new proposal = THRESHOLD.
	// Adding the new proposal brings total to 2 × THRESHOLD.
	// So the sub-solver needs balance ≥ 2 × THRESHOLD to pass.

	it("accepts when cumulative exposure plus new threshold equals balance exactly", async () => {
		// One in-flight proposal with the conservative gas estimate.
		const inflightGas = 200_000n; // ESCROW_GAS_ESTIMATION
		const inflightExposure = inflightGas * GAS_PRICE + MIN_COLLATERAL; // = THRESHOLD
		const required = inflightExposure + THRESHOLD; // = 2 × THRESHOLD

		const fetchInflight: FetchInflightGasUsed = async () => [inflightGas];

		const atBoundary = await validatorWith(
			clientWithBalance(required),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(atBoundary).toEqual({ kind: "accept", simulation: null });

		const oneBelowBoundary = await validatorWith(
			clientWithBalance(required - 1n),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(oneBelowBoundary).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
	});

	it("rejects when two in-flight proposals already consume the entire balance", async () => {
		// Two in-flight proposals each costing THRESHOLD → total 2 × THRESHOLD.
		// Balance = 2 × THRESHOLD is not enough to accept a third.
		const inflightGas = 200_000n;
		const fetchInflight: FetchInflightGasUsed = async () => [inflightGas, inflightGas];

		const balance = 2n * THRESHOLD; // exactly covers the two in-flight proposals

		const verdict = await validatorWith(
			clientWithBalance(balance),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		// balance (2T) >= threshold (T) → passes floor gate
		// exposure (2T) + threshold (T) = 3T > balance (2T) → fails cap
		expect(verdict).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
	});

	it("accumulates exposure across multiple in-flight proposals with varying gas", async () => {
		// Three in-flight proposals with distinct gas estimates.
		const gas1 = 100_000n;
		const gas2 = 150_000n;
		const gas3 = 250_000n;
		const exposure =
			gas1 * GAS_PRICE +
			MIN_COLLATERAL +
			gas2 * GAS_PRICE +
			MIN_COLLATERAL +
			gas3 * GAS_PRICE +
			MIN_COLLATERAL;
		const required = exposure + THRESHOLD;

		const fetchInflight: FetchInflightGasUsed = async () => [gas1, gas2, gas3];

		const atBoundary = await validatorWith(
			clientWithBalance(required),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(atBoundary).toEqual({ kind: "accept", simulation: null });

		const oneBelowBoundary = await validatorWith(
			clientWithBalance(required - 1n),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(oneBelowBoundary).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
	});

	it("unsimulated proposals (null gas) contribute minCollateral only (gasEstimate = 0n)", async () => {
		// An in-flight proposal without a gas estimate → gasEstimate treated as 0n.
		// Its exposure = 0n * gasPrice + minCollateral = minCollateral.
		const unsimulatedExposure = MIN_COLLATERAL; // 0n gas
		const required = unsimulatedExposure + THRESHOLD;

		// Null means no gas estimate yet.
		const fetchInflight: FetchInflightGasUsed = async () => [null];

		const atBoundary = await validatorWith(
			clientWithBalance(required),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(atBoundary).toEqual({ kind: "accept", simulation: null });

		const oneBelowBoundary = await validatorWith(
			clientWithBalance(required - 1n),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(oneBelowBoundary).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
	});

	it("fetchInflight error defers judgment", async () => {
		const fetchInflight: FetchInflightGasUsed = async () => {
			throw new Error("db connection lost");
		};

		const verdict = await validatorWith(
			clientWithBalance(100n * THRESHOLD),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("floor gate fires before exposure cap is checked", async () => {
		// Balance below the single-proposal threshold → InsufficientEscrow,
		// not ExposureCapExceeded, even if in-flight proposals exist.
		const fetchInflight: FetchInflightGasUsed = async () => [200_000n];

		const verdict = await validatorWith(
			clientWithBalance(THRESHOLD - 1n),
			GAS_PRICE,
			fetchInflight,
		).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "InsufficientEscrow" });
	});
});
