import { BUY_ETH_ADDRESS } from "@byos/common";
import { type Address, getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { CORRELATED_ASSETS } from "../correlated-assets.js";
import { selectSlippageBps } from "../slippage.js";

const usdt = "0x55d398326f99059ff775485246999027b3197955";
const usdc = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const eth = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const slisBnb = "0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b";
const unknown = "0x0000000000000000000000000000000000000001";
const options = {
	chainId: 56,
	sellToken: usdt,
	buyToken: usdc,
	defaultSlippageBps: 50,
	correlatedSlippageBps: 5,
} as const;

// Explicit pairs keep behavior tests independent of the registry's layout.
const pairs: readonly (readonly [string, Address, Address])[] = [
	["ETH", eth, "0xa2e3356610840701bdf5611a53974510ae27e2e1"],
	["USD", usdt, usdc],
	[
		"EUR",
		"0x9d1a7a3191102e9f900faa10540837ba84dcbae7",
		"0x4933a85b5b5466fbaf179f72d3de273c287ec2c2",
	],
	[
		"BTC",
		"0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
		"0x4aae823a6a0b376de6a78e74ecc5b079d38cbcf7",
	],
	["BNB", slisBnb, BUY_ETH_ADDRESS],
];

describe("selectSlippageBps", () => {
	it.each(pairs)(
		"uses correlated slippage for %s in either direction and address case",
		(_basket, sellToken, buyToken) => {
			for (const [sell, buy] of [
				[sellToken, buyToken],
				[buyToken, sellToken],
			] as const) {
				expect(selectSlippageBps({ ...options, sellToken: getAddress(sell), buyToken: buy })).toBe(
					5,
				);
			}
		},
	);

	it.each([
		[usdt, wbnb],
		[eth, BUY_ETH_ADDRESS],
		[usdt, unknown],
		[unknown, usdc],
		[unknown, unknown],
	] as const)(
		"retains ordinary slippage for unrelated or unknown assets %s / %s",
		(sellToken, buyToken) => {
			expect(selectSlippageBps({ ...options, sellToken, buyToken })).toBe(50);
		},
	);

	it.each([1, 100, 43114, 999_999])(
		"retains ordinary slippage on unconfigured chain %i",
		(chainId) => {
			expect(selectSlippageBps({ ...options, chainId })).toBe(50);
		},
	);

	it("recognizes wrapped/native BNB without a global native alias", () => {
		expect(selectSlippageBps({ ...options, sellToken: wbnb, buyToken: BUY_ETH_ADDRESS })).toBe(5);
		expect(
			selectSlippageBps({ ...options, chainId: 1, sellToken: wbnb, buyToken: BUY_ETH_ADDRESS }),
		).toBe(50);
	});

	it.each([0, 7, 10_000])(
		"uses the configured correlated value %i without clamping",
		(correlatedSlippageBps) => {
			expect(selectSlippageBps({ ...options, defaultSlippageBps: 1, correlatedSlippageBps })).toBe(
				correlatedSlippageBps,
			);
		},
	);
});

describe("correlated asset registry", () => {
	it("contains five nonoverlapping BSC baskets with valid token addresses", () => {
		const baskets = CORRELATED_ASSETS[56]!;
		expect(baskets.map((basket) => basket.length)).toEqual([3, 9, 2, 4, 5]);
		const addresses = baskets.flat().map((token) => token.toLowerCase());
		expect(new Set(addresses).size).toBe(23);
		expect(addresses.every((address) => isAddress(address))).toBe(true);
	});
});
