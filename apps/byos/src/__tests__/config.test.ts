import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";

const base = {
	DATABASE_URL: "postgres://localhost/byos",
	CHAIN_ID: "1",
	TRAMPOLINE_FACTORY: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7",
};

const chain = {
	RPC_URL: "http://localhost:8545",
	ORDERBOOK_URL: "http://localhost:8080",
	ESCROW_ADDRESS: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1",
	SETTLEMENT_ADDRESS: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
	MIN_COLLATERAL: "10000000000000000",
	DEFAULT_GAS_PRICE: "1000000000",
};

describe("parseConfig", () => {
	it("parses a minimal config without chain connectivity", () => {
		expect(parseConfig(base).RPC_URL).toBeUndefined();
	});

	it("parses a full chain-connected config", () => {
		const config = parseConfig({ ...base, ...chain });
		expect(config.MIN_COLLATERAL).toBe("10000000000000000");
	});

	it("rejects RPC_URL without its companion settings", () => {
		expect(() => parseConfig({ ...base, RPC_URL: chain.RPC_URL })).toThrow(
			/ORDERBOOK_URL.*required when RPC_URL is set/s,
		);
	});

	it("rejects RPC_URL when a single companion is missing", () => {
		const { MIN_COLLATERAL: _dropped, ...partial } = chain;
		expect(() => parseConfig({ ...base, ...partial })).toThrow(
			/MIN_COLLATERAL: required when RPC_URL is set/,
		);
	});

	it("rejects an operator key without RPC_URL", () => {
		expect(() => parseConfig({ ...base, OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}` })).toThrow(
			/OPERATOR_PRIVATE_KEY: requires RPC_URL/,
		);
	});

	it("rejects a malformed escrow address", () => {
		expect(() => parseConfig({ ...base, ...chain, ESCROW_ADDRESS: "not-an-address" })).toThrow(
			/ESCROW_ADDRESS/,
		);
	});
});
