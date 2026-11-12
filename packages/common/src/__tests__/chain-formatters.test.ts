import { describe, expect, it } from "vitest";
import {
	blockExplorerAddressUrl,
	blockExplorerTxUrl,
	formatNativeAmount,
	nativeCurrencySymbol,
	tenderlySimulationUrl,
	tenderlyTxUrl,
} from "../chain-formatters.js";

const address = `0x${"11".repeat(20)}`;
const hash = `0x${"aa".repeat(32)}`;

describe("shared chain formatting", () => {
	it.each([
		[1, "ETH"],
		[56, "BNB"],
		[100, "xDAI"],
		[43114, "AVAX"],
	] as const)("uses SDK native currency for chain %i", (chainId, symbol) => {
		expect(nativeCurrencySymbol(chainId)).toBe(symbol);
		expect(formatNativeAmount(1_000_000_000_000_000_000n, chainId)).toBe(`1 ${symbol}`);
	});

	it("formats Avalanche balances and uses its SDK explorer", () => {
		expect(formatNativeAmount("1250000000000000000", 43114)).toBe("1.25 AVAX");
		expect(blockExplorerAddressUrl(address, 43114)).toBe(`https://snowscan.xyz/address/${address}`);
		expect(blockExplorerTxUrl(hash, 43114)).toBe(`https://snowscan.xyz/tx/${hash}`);
	});

	it("retains legacy Chiado display support and unknown-chain fallbacks", () => {
		expect(blockExplorerTxUrl(hash, 10200)).toContain("blockscout.chiadochain.net");
		expect(tenderlyTxUrl(hash, 10200)).toContain("/tx/chiado/");
		expect(blockExplorerTxUrl(hash, 99999)).toBeNull();
		expect(blockExplorerAddressUrl(address, 99999)).toBeNull();
		expect(tenderlyTxUrl(hash, 99999)).toBeNull();
		expect(formatNativeAmount(0n, 99999)).toBe("0 ETH");
	});

	it("builds Avalanche Tenderly links and preserves simulation parameters", () => {
		expect(tenderlyTxUrl(hash, 43114)).toBe(
			`https://dashboard.tenderly.co/tx/avalanche-mainnet/${hash}`,
		);
		const params = {
			chainId: 43114,
			blockNumber: "12345",
			timestamp: 123,
			from: address,
			to: address,
			calldata: "0x1234",
		};
		const result = tenderlySimulationUrl(params);
		expect(result).not.toBeNull();
		const url = new URL(result ?? "");
		expect(url.searchParams.get("network")).toBe("43114");
		expect(url.searchParams.get("blockNumber")).toBe("12345");
		expect(url.searchParams.get("rawFunctionInput")).toBe("0x1234");
		expect(tenderlySimulationUrl({ ...params, chainId: 99999 })).toBeNull();
	});
});
