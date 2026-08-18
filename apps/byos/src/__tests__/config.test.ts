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

describe("rate limit config", () => {
	it("defaults the tier and window to values sized from poll volume", () => {
		const config = parseConfig(base);

		expect(config.RATE_LIMIT_WINDOW_SECS).toBe(60);
		expect(config.RATE_UNIT_WEI).toBe("100000000000000000");
		expect(config.RATE_PER_UNIT).toBe(300);
		expect(config.RATE_MIN_PER_WINDOW).toBe(120);
		expect(config.RATE_MAX_PER_WINDOW).toBe(3000);
		expect(config.RATE_LIMIT_IP_PER_WINDOW).toBe(6000);
	});

	it("rejects a zero rate unit, which would divide by zero at startup", () => {
		expect(() => parseConfig({ ...base, RATE_UNIT_WEI: "0" })).toThrow(/RATE_UNIT_WEI/);
	});

	it("rejects a minimum rate above the maximum", () => {
		expect(() =>
			parseConfig({ ...base, RATE_MIN_PER_WINDOW: "5000", RATE_MAX_PER_WINDOW: "3000" }),
		).toThrow(/RATE_MIN_PER_WINDOW/);
	});

	it("defaults the balance refresh loop to bounded, self-evicting values", () => {
		const config = parseConfig(base);

		expect(config.BALANCE_REFRESH_INTERVAL_SECS).toBe(60);
		// An hour of idleness, well past MAX_PROPOSAL_LIFETIME_SECS, so
		// eviction can never orphan reserve accounting.
		expect(config.BALANCE_EVICTION_SECS).toBe(3600);
		expect(config.BALANCE_NEGATIVE_TTL_SECS).toBe(600);
		expect(config.BALANCE_ACTIVE_SET_MAX).toBe(100_000);
	});
});
