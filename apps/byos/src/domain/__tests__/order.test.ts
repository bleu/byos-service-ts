import { type CowOrder, OrderKind, SigningScheme } from "@byos/common";
import { describe, expect, it } from "vitest";
import { checkEnvelope, type OrderRecord } from "../order.js";
import type { Proposal } from "../proposal.js";

function sampleOrder(): CowOrder {
	return {
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		receiver: "0xd2e80D60aff5377587E49FF32c9bad639d6f68Bc",
		sellAmount: 1_000_000n,
		buyAmount: 980_000n,
		validTo: 1_700_000_000,
		appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
		feeAmount: 0n,
		kind: OrderKind.SELL,
		partiallyFillable: false,
		signingScheme: SigningScheme.Eip712,
		signature: `0x${"ab".repeat(65)}`,
	};
}

function sampleRecord(overrides?: Partial<OrderRecord>): OrderRecord {
	return {
		order: sampleOrder(),
		preInteractions: [],
		postInteractions: [],
		erc20Balances: true,
		...overrides,
	};
}

function matchingProposal(overrides?: Partial<Proposal>): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}`,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quotedBuyAmount: 990_000n,
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

describe("order envelope", () => {
	it("non-erc20 balances are rejected", () => {
		const result = checkEnvelope(sampleRecord({ erc20Balances: false }), matchingProposal());
		expect(result).toBe("UnsupportedOrder");
	});

	it("rejects minBuyAmount > quotedBuyAmount", () => {
		const result = checkEnvelope(
			sampleRecord(),
			matchingProposal({ minBuyAmount: 1_000_000n, quotedBuyAmount: 900_000n }),
		);
		expect(result).toBe("AmountMismatch");
	});

	describe("fill-or-kill sell order", () => {
		it("accepts matching sell amount with equal min/max", () => {
			const result = checkEnvelope(sampleRecord(), matchingProposal());
			expect(result).toBeNull();
		});

		it("accepts matching sell amount with loose slippage", () => {
			const result = checkEnvelope(
				sampleRecord(),
				matchingProposal({ minBuyAmount: 980_000n, quotedBuyAmount: 990_000n }),
			);
			expect(result).toBeNull();
		});

		it("rejects mismatched sell amount", () => {
			const result = checkEnvelope(sampleRecord(), matchingProposal({ sellAmount: 999_999n }));
			expect(result).toBe("AmountMismatch");
		});

		it("rejects minBuyAmount below order limit", () => {
			const result = checkEnvelope(
				sampleRecord(),
				matchingProposal({ minBuyAmount: 979_999n, quotedBuyAmount: 990_000n }),
			);
			expect(result).toBe("AmountMismatch");
		});
	});

	describe("fill-or-kill buy order", () => {
		it("accepts matching buy amount with equal min/max", () => {
			const record = sampleRecord({
				order: { ...sampleOrder(), kind: OrderKind.BUY },
			});
			const proposal = matchingProposal({ minBuyAmount: 980_000n, quotedBuyAmount: 980_000n });
			expect(checkEnvelope(record, proposal)).toBeNull();
		});

		it("rejects mismatched buy amount", () => {
			const record = sampleRecord({
				order: { ...sampleOrder(), kind: OrderKind.BUY },
			});
			const proposal = matchingProposal({ minBuyAmount: 979_999n, quotedBuyAmount: 979_999n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects minBuyAmount != quotedBuyAmount", () => {
			const record = sampleRecord({
				order: { ...sampleOrder(), kind: OrderKind.BUY },
			});
			const proposal = matchingProposal({ minBuyAmount: 970_000n, quotedBuyAmount: 980_000n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});
	});

	describe("partial fill sell order", () => {
		const record = sampleRecord({
			order: { ...sampleOrder(), partiallyFillable: true },
		});

		it("accepts partial fill within limit price", () => {
			// Half fill: sell 500_000, buy must be >= 500_000 * 980_000 / 1_000_000 = 490_000
			const proposal = matchingProposal({
				sellAmount: 500_000n,
				minBuyAmount: 500_000n,
				quotedBuyAmount: 500_000n,
			});
			expect(checkEnvelope(record, proposal)).toBeNull();
		});

		it("accepts partial fill with loose slippage", () => {
			const proposal = matchingProposal({
				sellAmount: 500_000n,
				minBuyAmount: 490_000n,
				quotedBuyAmount: 500_000n,
			});
			expect(checkEnvelope(record, proposal)).toBeNull();
		});

		it("rejects zero sell amount", () => {
			const proposal = matchingProposal({ sellAmount: 0n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects sell amount exceeding order", () => {
			const proposal = matchingProposal({ sellAmount: 1_000_001n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects quotedBuyAmount below limit price", () => {
			// proposal_maxBuy * order_sell < proposal_sell * order_buy → below limit
			const proposal = matchingProposal({
				sellAmount: 500_000n,
				minBuyAmount: 489_999n,
				quotedBuyAmount: 489_999n,
			});
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects minBuyAmount below scaled limit price", () => {
			// quotedBuyAmount beats limit but minBuyAmount doesn't
			const proposal = matchingProposal({
				sellAmount: 500_000n,
				minBuyAmount: 489_999n,
				quotedBuyAmount: 500_000n,
			});
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});
	});

	describe("partial fill buy order", () => {
		const record = sampleRecord({
			order: { ...sampleOrder(), kind: OrderKind.BUY, partiallyFillable: true },
		});

		it("accepts partial fill within limit", () => {
			const proposal = matchingProposal({
				minBuyAmount: 490_000n,
				quotedBuyAmount: 490_000n,
				sellAmount: 500_000n,
			});
			expect(checkEnvelope(record, proposal)).toBeNull();
		});

		it("rejects zero buy amount", () => {
			const proposal = matchingProposal({ minBuyAmount: 0n, quotedBuyAmount: 0n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects buy amount exceeding order", () => {
			const proposal = matchingProposal({ minBuyAmount: 980_001n, quotedBuyAmount: 980_001n });
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects zero sell amount", () => {
			const proposal = matchingProposal({
				minBuyAmount: 490_000n,
				quotedBuyAmount: 490_000n,
				sellAmount: 0n,
			});
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});

		it("rejects minBuyAmount != quotedBuyAmount", () => {
			const proposal = matchingProposal({
				minBuyAmount: 480_000n,
				quotedBuyAmount: 490_000n,
				sellAmount: 500_000n,
			});
			expect(checkEnvelope(record, proposal)).toBe("AmountMismatch");
		});
	});
});
