import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";

const base = {
	DATABASE_URL: "postgres://localhost/byos",
	CHAIN_ID: "1",
	TRAMPOLINE_FACTORY: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7",
	RPC_URL: "http://localhost:8545",
	ESCROW_ADDRESS: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1",
	DEFAULT_GAS_PRICE: "1000000000",
	OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
};

describe("parseConfig", () => {
	it("parses a minimal config with all required fields", () => {
		const config = parseConfig(base);
		expect(config.RPC_URL).toBe(base.RPC_URL);
		expect(config.ESCROW_ADDRESS).toBe(base.ESCROW_ADDRESS);
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

	it("defaults MIN_COLLATERAL to 10^16 wei when not set", () => {
		// The default is a placeholder (COW-1265) — identical to what the old
		// per-chain table carried for every EVM chain. Operators override it via
		// MIN_COLLATERAL when deploying.
		expect(parseConfig(base).MIN_COLLATERAL).toBe("10000000000000000");
	});

	it("rejects a MIN_COLLATERAL that is not a decimal wei amount", () => {
		expect(() => parseConfig({ ...base, MIN_COLLATERAL: "0.5" })).toThrow(/MIN_COLLATERAL/);
	});

	it("rejects a missing RPC_URL", () => {
		const { RPC_URL: _dropped, ...partial } = base;
		expect(() => parseConfig(partial)).toThrow(/RPC_URL/);
	});

	it("rejects a missing ESCROW_ADDRESS", () => {
		const { ESCROW_ADDRESS: _dropped, ...partial } = base;
		expect(() => parseConfig(partial)).toThrow(/ESCROW_ADDRESS/);
	});

	it("rejects a missing OPERATOR_PRIVATE_KEY", () => {
		const { OPERATOR_PRIVATE_KEY: _dropped, ...partial } = base;
		expect(() => parseConfig(partial)).toThrow(/OPERATOR_PRIVATE_KEY/);
	});

	it("rejects a malformed escrow address", () => {
		expect(() => parseConfig({ ...base, ESCROW_ADDRESS: "not-an-address" })).toThrow(
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
