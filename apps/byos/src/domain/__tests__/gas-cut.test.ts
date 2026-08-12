import { describe, expect, it } from "vitest";
import { gasCutSize } from "../gas-cut.js";

const ETHER = 10n ** 18n;

/** Sell token worth 0.5 wei per atom → price = 0.5e18 */
function sellOrder(orderBuy: bigint, proposalBuy: bigint, gasCost: bigint) {
	return gasCutSize(
		{
			orderSell: 1_000_000n,
			orderBuy,
			proposalSell: 1_000_000n,
			proposalBuy,
			isSellOrder: true,
			gasCost,
		},
		ETHER / 2n,
	);
}

describe("gas cut", () => {
	it("sell order cut is the gas cost in sell token atoms", () => {
		const cut = sellOrder(900_000n, 1_000_000n, 100n);
		expect(cut).toEqual({ amount: 200n, executedAmount: 999_800n });
	});

	it("sell order cut that breaches the signed limit is skipped", () => {
		expect(sellOrder(899_900n, 900_000n, 100n)).toBeNull();
	});

	it("sell order cut that lands exactly on the limit is kept", () => {
		const cut = sellOrder(999_800n, 1_000_000n, 100n);
		expect(cut?.executedAmount).toBe(999_800n);
	});

	it("a cut that does not divide evenly rounds up", () => {
		// 3 wei of gas at 2 wei per atom is 1.5 atoms → 2
		const cut = gasCutSize(
			{
				orderSell: 1_000_000n,
				orderBuy: 900_000n,
				proposalSell: 1_000_000n,
				proposalBuy: 1_000_000n,
				isSellOrder: true,
				gasCost: 3n,
			},
			ETHER * 2n,
		);
		expect(cut?.amount).toBe(2n);
	});

	it("an unpriced sell token cannot be cut", () => {
		const cut = gasCutSize(
			{
				orderSell: 1_000_000n,
				orderBuy: 900_000n,
				proposalSell: 1_000_000n,
				proposalBuy: 1_000_000n,
				isSellOrder: true,
				gasCost: 100n,
			},
			0n,
		);
		expect(cut).toBeNull();
	});

	it("buy order executes the signed buy amount", () => {
		const cut = gasCutSize(
			{
				orderSell: 1_000_000n,
				orderBuy: 900_000n,
				proposalSell: 950_000n,
				proposalBuy: 900_000n,
				isSellOrder: false,
				gasCost: 100n,
			},
			ETHER / 2n,
		);
		expect(cut).toEqual({ amount: 200n, executedAmount: 900_000n });
	});

	it("buy order cut over the signed sell amount is skipped", () => {
		const cut = gasCutSize(
			{
				orderSell: 1_000_000n,
				orderBuy: 900_000n,
				proposalSell: 999_900n,
				proposalBuy: 900_000n,
				isSellOrder: false,
				gasCost: 100n,
			},
			ETHER / 2n,
		);
		expect(cut).toBeNull();
	});
});
