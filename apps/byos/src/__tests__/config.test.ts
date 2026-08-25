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

	it("accepts every EVM chain CoW settles on", () => {
		for (const id of [1, 100, 137, 8453, 42161, 11155111]) {
			expect(parseConfig({ ...base, CHAIN_ID: String(id) }).CHAIN_ID).toBe(id);
		}
	});

	it("rejects a chain CoW does not settle on", () => {
		// The chain drives viem's Multicall3 lookup for the batched escrow
		// reads, so an id we cannot describe must fail at startup rather than
		// leave the balance cache silently empty.
		expect(() => parseConfig({ ...base, CHAIN_ID: "999999" })).toThrow(/CHAIN_ID/);
	});

	it("rejects Solana, which BYOS cannot settle on", () => {
		expect(() => parseConfig({ ...base, CHAIN_ID: "1000000001" })).toThrow(/CHAIN_ID/);
	});

	it("rejects a fractional count or duration", () => {
		// These are not cosmetic bounds. The three rate constants reach
		// BigInt() in the tier function, and the window, negative TTL and
		// active-set cap reach EXPIRE, SET EX and ZREMRANGEBYRANK — each
		// throws on a fractional value at request time, not at startup.
		const knobs = [
			"RATE_LIMIT_WINDOW_SECS",
			"RATE_LIMIT_IP_PER_WINDOW",
			"RATE_PER_UNIT",
			"RATE_MIN_PER_WINDOW",
			"RATE_MAX_PER_WINDOW",
			"BALANCE_REFRESH_INTERVAL_SECS",
			"BALANCE_EVICTION_SECS",
			"BALANCE_NEGATIVE_TTL_SECS",
			"BALANCE_ACTIVE_SET_MAX",
			"BALANCE_REFRESH_BATCH_SIZE",
		];

		for (const knob of knobs) {
			expect(() => parseConfig({ ...base, [knob]: "1.5" }), knob).toThrow(knob);
		}
	});

	it("accepts a fixed rate, where the floor equals the ceiling", () => {
		const config = parseConfig({
			...base,
			RATE_MIN_PER_WINDOW: "500",
			RATE_MAX_PER_WINDOW: "500",
		});

		expect(config.RATE_MIN_PER_WINDOW).toBe(500);
	});

	it("rejects a floor above the ceiling", () => {
		expect(() =>
			parseConfig({ ...base, RATE_MIN_PER_WINDOW: "501", RATE_MAX_PER_WINDOW: "500" }),
		).toThrow(/RATE_MIN_PER_WINDOW/);
	});

	it("treats MIN_COLLATERAL as optional, since the chain supplies a default", () => {
		const { MIN_COLLATERAL: _omitted, ...withoutFloor } = chain;
		expect(parseConfig({ ...base, ...withoutFloor }).MIN_COLLATERAL).toBeUndefined();
	});

	it("rejects a MIN_COLLATERAL that is not a decimal wei amount", () => {
		expect(() => parseConfig({ ...base, ...chain, MIN_COLLATERAL: "0.5" })).toThrow(
			/MIN_COLLATERAL/,
		);
	});

	it("rejects RPC_URL without DEFAULT_GAS_PRICE (the only remaining required companion)", () => {
		expect(() => parseConfig({ ...base, RPC_URL: chain.RPC_URL })).toThrow(
			/DEFAULT_GAS_PRICE.*required when RPC_URL is set/s,
		);
	});

	it("accepts RPC_URL without ESCROW_ADDRESS (resolved from chain at context build)", () => {
		// ESCROW_ADDRESS is now an optional override; the chain record handles it.
		const { ESCROW_ADDRESS: _dropped, ...partial } = chain;
		expect(() => parseConfig({ ...base, ...partial })).not.toThrow();
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
		// The cap is an RPC deadline as much as a memory bound: a tick issues
		// ceil(cap / batch) requests back to back.
		expect(config.BALANCE_ACTIVE_SET_MAX).toBe(10_000);
	});
});
