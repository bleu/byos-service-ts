import { type CowOrder, OrderKind, SigningScheme } from "@byos/common";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "../../../domain/order.js";
import type { Proposal } from "../../../domain/proposal.js";
import type { FetchOrder } from "../../orderbook.js";
import { SimulationValidator } from "../validator.js";

const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const ESCROW = "0x1111111111111111111111111111111111111234";
const TRAMPOLINE_FACTORY = "0x2222222222222222222222222222222222221234";
const AUTHENTICATOR = "0x3333333333333333333333333333333333331234";
const ETHER = 10n ** 18n;

function sampleOrder(overrides?: Partial<CowOrder>): CowOrder {
	return {
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		receiver: "0xd2e80D60aff5377587E49FF32c9bad639d6f68Bc",
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
		validTo: 1_700_000_000,
		appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
		feeAmount: 0n,
		kind: OrderKind.SELL,
		partiallyFillable: false,
		signingScheme: SigningScheme.Eip712,
		signature: `0x${"ab".repeat(65)}`,
		...overrides,
	};
}

function sampleRecord(order: CowOrder): OrderRecord {
	return {
		order,
		preInteractions: [],
		postInteractions: [],
		erc20Balances: true,
	};
}

function submittedProposal(): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}`,
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
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
		// Pre-populated so validate() never resolves the trampoline via RPC.
		trampoline: "0x4444444444444444444444444444444444441234",
		settlementTxHash: null,
		penaltyTxHash: null,
	};
}

function fakePublicClient(): PublicClient {
	return {
		readContract: async () => AUTHENTICATOR,
		estimateGas: async () => 100_000n,
	} as unknown as PublicClient;
}

function fakeOrderbook(record: OrderRecord): FetchOrder {
	return {
		order: async () => record,
		nativePrice: async () => ETHER, // 1:1 — surplus in atoms equals surplus in wei
	};
}

function validatorWith(record: OrderRecord, minScore: bigint): SimulationValidator {
	return new SimulationValidator(
		fakePublicClient(),
		fakeOrderbook(record),
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		{ value: 0n }, // zero gas price: score is exactly the priced surplus
		minScore,
	);
}

describe("SimulationValidator profitability gate", () => {
	it("zero-surplus first simulation rejects as unprofitable", async () => {
		// Order limit equal to the proposal's buy amount: zero surplus. With a
		// zero gas price the score is exactly 0, which must NOT exceed the
		// default minScore of 0 — score must be strictly greater.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.buyAmount }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score exactly at a nonzero minScore rejects", async () => {
		// Surplus of 10_000 atoms priced 1:1 scores exactly 10_000.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.buyAmount - 10_000n }));

		const verdict = await validatorWith(record, 10_000n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score above minScore accepts", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.buyAmount - 10_000n }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toMatchObject({ kind: "accept" });
	});
});
