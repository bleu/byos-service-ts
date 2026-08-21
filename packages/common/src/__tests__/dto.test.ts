import { describe, expect, it } from "vitest";

import {
	createProposalRequestSchema,
	createProposalResponseSchema,
	getProposalResponseSchema,
	isTerminalStatus,
	listProposalsResponseSchema,
	Status,
	statusSchema,
} from "../dto.js";

describe("DTO schemas", () => {
	describe("createProposalRequestSchema", () => {
		it("accepts a valid request", () => {
			const result = createProposalRequestSchema.safeParse({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
				buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
				sellAmount: "1000000000000000000",
				minBuyAmount: "5000000",
				quoteBuyAmount: "5000000",
				interactions: [
					{
						target: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
						value: "0",
						callData: "0xabcdef",
					},
				],
				validUntil: "1750000000",
				nonce: "0",
				signature: `0x${"ab".repeat(65)}`,
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing fields", () => {
			const result = createProposalRequestSchema.safeParse({
				orderUid: "0xabc",
			});
			expect(result.success).toBe(false);
		});

		it("rejects invalid interaction target", () => {
			const result = createProposalRequestSchema.safeParse({
				orderUid: `0x${"ab".repeat(56)}`,
				sellAmount: "1000",
				minBuyAmount: "500",
				quoteBuyAmount: "500",
				interactions: [
					{
						target: "not-an-address",
						value: "0",
						callData: "0x",
					},
				],
				validUntil: "1750000000",
				nonce: "0",
				signature: `0x${"ab".repeat(65)}`,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("createProposalResponseSchema", () => {
		it("accepts a valid response", () => {
			const result = createProposalResponseSchema.safeParse({ id: 42 });
			expect(result.success).toBe(true);
		});
	});

	describe("statusSchema", () => {
		it("accepts all known statuses", () => {
			for (const status of Object.values(Status)) {
				expect(statusSchema.safeParse(status).success).toBe(true);
			}
		});

		it("rejects unknown status", () => {
			expect(statusSchema.safeParse("nonexistent").success).toBe(false);
		});
	});

	describe("isTerminalStatus", () => {
		it("submitted is not terminal", () => {
			expect(isTerminalStatus(Status.Submitted)).toBe(false);
		});

		it("active is not terminal", () => {
			expect(isTerminalStatus(Status.Active)).toBe(false);
		});

		it("executing is not terminal", () => {
			expect(isTerminalStatus(Status.Executing)).toBe(false);
		});

		const terminalStatuses = [
			Status.Rejected,
			Status.Expired,
			Status.Settled,
			Status.SettleFailed,
			Status.Penalized,
			Status.SimFailed,
			Status.Cancelled,
		] as const;

		for (const status of terminalStatuses) {
			it(`${status} is terminal`, () => {
				expect(isTerminalStatus(status)).toBe(true);
			});
		}
	});

	describe("getProposalResponseSchema", () => {
		it("accepts a full response with optional fields", () => {
			const result = getProposalResponseSchema.safeParse({
				id: 1,
				subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
				orderUid: `0x${"ab".repeat(56)}`,
				sellAmount: "1000000",
				minBuyAmount: "990000",
				quoteBuyAmount: "990000",
				validUntil: "1750000000",
				status: "active",
				rejectionReason: undefined,
				settlementTxHash: `0x${"cd".repeat(32)}`,
			});
			expect(result.success).toBe(true);
		});

		it("accepts a response without optional fields", () => {
			const result = getProposalResponseSchema.safeParse({
				id: 1,
				subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
				orderUid: `0x${"ab".repeat(56)}`,
				sellAmount: "1000000",
				minBuyAmount: "990000",
				quoteBuyAmount: "990000",
				validUntil: "1750000000",
				status: "submitted",
			});
			expect(result.success).toBe(true);
		});
	});

	describe("listProposalsResponseSchema", () => {
		it("accepts a valid list", () => {
			const result = listProposalsResponseSchema.safeParse({
				proposals: [
					{
						id: 1,
						subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
						validUntil: "1750000000",
						status: "active",
					},
				],
			});
			expect(result.success).toBe(true);
		});

		it("accepts an empty list", () => {
			const result = listProposalsResponseSchema.safeParse({
				proposals: [],
			});
			expect(result.success).toBe(true);
		});
	});
});

// Ported from the Rust edge-parser tests (byos infra/api/dto.rs): the wire
// grammar for amounts and byte strings must reject what parse_u256/parse_hex
// reject and accept what they accept.
describe("wire grammar", () => {
	const valid = {
		orderUid: `0x${"ab".repeat(56)}`,
		sellToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		sellAmount: "1000000000000000000",
		minBuyAmount: "5000000",
		quoteBuyAmount: "5000000",
		interactions: [
			{
				target: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
				value: "0",
				callData: "0xabcdef",
			},
		],
		validUntil: "1750000000",
		nonce: "0",
		signature: `0x${"ab".repeat(65)}`,
	};

	function accepts(overrides: Record<string, unknown>): boolean {
		return createProposalRequestSchema.safeParse({ ...valid, ...overrides }).success;
	}

	function withCallData(callData: string) {
		return { interactions: [{ ...valid.interactions[0], callData }] };
	}

	it("hex accepts a bare prefix as empty", () => {
		// An interaction with no calldata is a plain value transfer.
		expect(accepts(withCallData("0x"))).toBe(true);
		expect(accepts(withCallData(""))).toBe(true);
	});

	it("hex rejects an odd digit count", () => {
		expect(accepts(withCallData("0xabc"))).toBe(false);
		expect(accepts(withCallData("abc"))).toBe(false);
	});

	it("hex rejects non-hex digits", () => {
		expect(accepts(withCallData("0xzz"))).toBe(false);
		expect(accepts(withCallData("0x 1"))).toBe(false);
	});

	it("hex accepts a missing 0x prefix", () => {
		expect(accepts(withCallData("abcd"))).toBe(true);
		expect(accepts({ signature: "ab".repeat(65) })).toBe(true);
		expect(accepts({ orderUid: "ab".repeat(56) })).toBe(true);
	});

	it("u256 keeps leading zeros and rejects other shapes", () => {
		expect(accepts({ sellAmount: "000123" })).toBe(true);
		// Hex is the wrong base here — amounts are decimal on the wire
		// (ADR-0005), so 0x10 must not silently read as 16.
		expect(accepts({ sellAmount: "0x10" })).toBe(false);
		expect(accepts({ sellAmount: "-1" })).toBe(false);
		expect(accepts({ sellAmount: "1.5" })).toBe(false);
		expect(accepts({ sellAmount: " 1" })).toBe(false);
	});

	it("u256 reads an empty string as zero", () => {
		// Pins the upstream ruint behaviour the Rust test documents.
		expect(accepts({ sellAmount: "" })).toBe(true);
		expect(BigInt("")).toBe(0n);
	});

	it("u256 rejects a value past the maximum", () => {
		const max = (2n ** 256n - 1n).toString();
		expect(accepts({ sellAmount: max })).toBe(true);
		expect(accepts({ sellAmount: (2n ** 256n).toString() })).toBe(false);
	});

	it("orderUid must be exactly 56 bytes", () => {
		expect(accepts({ orderUid: `0x${"ab".repeat(55)}` })).toBe(false);
		expect(accepts({ orderUid: `0x${"ab".repeat(57)}` })).toBe(false);
	});
});
