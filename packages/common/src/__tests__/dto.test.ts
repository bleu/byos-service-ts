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
				sellAmount: "1000000000000000000",
				buyAmount: "5000000",
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
				buyAmount: "500",
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
				buyAmount: "990000",
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
				buyAmount: "990000",
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
