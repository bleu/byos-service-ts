import { describe, expect, it } from "vitest";
import {
	type Candidate,
	effectiveGas,
	GAS_BUFFER,
	scaledToFill,
	scoreProposal,
} from "../scoring.js";

const ETHER = 10n ** 18n;

describe("scoring", () => {
	it("effectiveGas adds the buffer", () => {
		expect(effectiveGas(200_000n)).toBe(200_000n + GAS_BUFFER);
	});

	it("sell order positive surplus", () => {
		// Surplus token (buy token) worth 0.5 ETH per 1e18 atoms
		const score = scoreProposal(
			{
				orderSell: 1_000n,
				orderBuy: 900n,
				proposalSell: 1_000n,
				proposalBuy: 950n,
				isSellOrder: true,
				gasCost: 0n,
			},
			ETHER / 2n,
		);
		// surplus = 950 - 900 = 50; surplus_eth = 50 * 0.5e18 / 1e18 = 25
		expect(score).toBe(25n);
	});

	it("buy order positive surplus", () => {
		const score = scoreProposal(
			{
				orderSell: 1_000n,
				orderBuy: 900n,
				proposalSell: 950n,
				proposalBuy: 900n,
				isSellOrder: false,
				gasCost: 0n,
			},
			ETHER / 2n,
		);
		// surplus = 1000 - 950 = 50; surplus_eth = 25
		expect(score).toBe(25n);
	});

	it("proposal below minimum returns null", () => {
		const score = scoreProposal(
			{
				orderSell: 1_000n,
				orderBuy: 900n,
				proposalSell: 1_000n,
				proposalBuy: 800n, // below order's buy minimum
				isSellOrder: true,
				gasCost: 0n,
			},
			ETHER,
		);
		expect(score).toBeNull();
	});

	it("gas exceeds surplus returns null", () => {
		const score = scoreProposal(
			{
				orderSell: 1_000n,
				orderBuy: 900n,
				proposalSell: 1_000n,
				proposalBuy: 910n, // surplus = 10
				isSellOrder: true,
				gasCost: 20n, // gas = 20 > surplus_eth (10)
			},
			ETHER,
		);
		expect(score).toBeNull();
	});

	it("zero surplus minus zero gas", () => {
		const score = scoreProposal(
			{
				orderSell: 1_000n,
				orderBuy: 900n,
				proposalSell: 1_000n,
				proposalBuy: 900n, // exactly at minimum
				isSellOrder: true,
				gasCost: 0n,
			},
			ETHER,
		);
		expect(score).toBe(0n);
	});

	describe("scaledToFill", () => {
		it("fill-or-kill passes through", () => {
			const c: Candidate = {
				orderSell: 1000n,
				orderBuy: 900n,
				proposalSell: 1000n,
				proposalBuy: 950n,
				isSellOrder: true,
				gasCost: 0n,
			};
			const result = scaledToFill(c, false);
			expect(result).toEqual(c);
		});

		it("partial sell scales buy limit (ceil div)", () => {
			const result = scaledToFill(
				{
					orderSell: 1000n,
					orderBuy: 900n,
					proposalSell: 500n,
					proposalBuy: 480n,
					isSellOrder: true,
					gasCost: 0n,
				},
				true,
			);
			expect(result?.orderSell).toBe(500n);
			expect(result?.orderBuy).toBe(450n); // ceil(900 * 500 / 1000)
		});

		it("partial sell ceil div rounds up", () => {
			const result = scaledToFill(
				{
					orderSell: 1000n,
					orderBuy: 901n,
					proposalSell: 500n,
					proposalBuy: 460n,
					isSellOrder: true,
					gasCost: 0n,
				},
				true,
			);
			expect(result?.orderBuy).toBe(451n); // ceil(901 * 500 / 1000) = 451
		});

		it("partial buy scales sell limit (floor div)", () => {
			const result = scaledToFill(
				{
					orderSell: 1000n,
					orderBuy: 900n,
					proposalSell: 480n,
					proposalBuy: 450n,
					isSellOrder: false,
					gasCost: 0n,
				},
				true,
			);
			expect(result?.orderSell).toBe(500n); // floor(1000 * 450 / 900)
			expect(result?.orderBuy).toBe(450n);
		});

		it("partial buy floor div rounds down", () => {
			const result = scaledToFill(
				{
					orderSell: 1001n,
					orderBuy: 900n,
					proposalSell: 480n,
					proposalBuy: 450n,
					isSellOrder: false,
					gasCost: 0n,
				},
				true,
			);
			expect(result?.orderSell).toBe(500n); // floor(1001 * 450 / 900) = 500
		});

		it("full fill of partial order is noop", () => {
			const result = scaledToFill(
				{
					orderSell: 1000n,
					orderBuy: 900n,
					proposalSell: 1000n,
					proposalBuy: 950n,
					isSellOrder: true,
					gasCost: 0n,
				},
				true,
			);
			expect(result?.orderSell).toBe(1000n);
			expect(result?.orderBuy).toBe(900n);
		});

		it("zero order_sell returns null", () => {
			const result = scaledToFill(
				{
					orderSell: 0n,
					orderBuy: 900n,
					proposalSell: 0n,
					proposalBuy: 450n,
					isSellOrder: true,
					gasCost: 0n,
				},
				true,
			);
			expect(result).toBeNull();
		});
	});
});
