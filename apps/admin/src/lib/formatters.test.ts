import { afterEach, describe, expect, it, vi } from "vitest";
import {
	blockExplorerAddressUrl,
	formatNativeAmount,
	getNativeCurrencySymbol,
	tenderlySimulationUrl,
	txLinks,
} from "./formatters.js";

const address = `0x${"11".repeat(20)}`;
const hash = `0x${"aa".repeat(32)}`;
afterEach(() => vi.unstubAllEnvs());

describe("admin deployment chain", () => {
	it.each([
		["43114", "AVAX"],
		["56", "BNB"],
		["1", "ETH"],
	])("formats balances and table units for chain %s", (chainId, symbol) => {
		vi.stubEnv("CHAIN_ID", chainId);
		expect(getNativeCurrencySymbol()).toBe(symbol);
		expect(formatNativeAmount("1000000000000000000")).toBe(`1 ${symbol}`);
	});

	it("returns Avalanche explorer and Tenderly links", () => {
		vi.stubEnv("CHAIN_ID", "43114");
		expect(blockExplorerAddressUrl(address)).toBe(`https://snowscan.xyz/address/${address}`);
		expect(txLinks(hash)).toEqual({
			explorerUrl: `https://snowscan.xyz/tx/${hash}`,
			tenderlyUrl: `https://dashboard.tenderly.co/tx/avalanche-mainnet/${hash}`,
		});
		expect(txLinks(null)).toEqual({ explorerUrl: null, tenderlyUrl: null });
	});

	it("uses the simulation's chain independently of the dashboard environment", () => {
		vi.stubEnv("CHAIN_ID", "56");
		expect(
			tenderlySimulationUrl({
				chainId: 43114,
				blockNumber: "5",
				timestamp: 10,
				from: address,
				to: address,
				calldata: "0x",
			}),
		).toContain("network=43114");
	});
});
