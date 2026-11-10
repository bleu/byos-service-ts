import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const base = {
	BINANCE_API_KEY: "key",
	BINANCE_SECRET_KEY: "secret",
	DISCOVERY_METHOD: "solve",
	BYOS_URL: "http://byos",
	RPC_URL: "http://rpc",
	SUBSOLVER_PRIVATE_KEY: "0x01",
	CHAIN_ID: "56",
	TRAMPOLINE_FACTORY: "0x0000000000000000000000000000000000000001",
	GPV2_SETTLEMENT: "0x0000000000000000000000000000000000000002",
};

describe("solve discovery config", () => {
	it.each(["orderbook", "aws"])("requires a URL for %s", (method) => {
		expect(() => parseConfig({ ...base, DISCOVERY_METHOD: method })).toThrow(/DISCOVERY_URL/);
		expect(
			parseConfig({ ...base, DISCOVERY_METHOD: method, DISCOVERY_URL: "http://discovery" })
				.discoveryMethod,
		).toBe(method);
	});
	it("defaults and validates selection and listener settings", () => {
		expect(parseConfig({ ...base, SUBSOLVER_BEARER: "secret" })).toMatchObject({
			closeToExecutionTopN: 20,
			solvePort: 3001,
		});
		expect(
			parseConfig({
				...base,
				SUBSOLVER_BEARER: "secret",
				CLOSE_TO_EXECUTION_TOP_N: "5",
				SOLVE_PORT: "3002",
			}),
		).toMatchObject({
			closeToExecutionTopN: 5,
			solvePort: 3002,
		});
		expect(() =>
			parseConfig({ ...base, SUBSOLVER_BEARER: "secret", CLOSE_TO_EXECUTION_TOP_N: "0" }),
		).toThrow(/CLOSE_TO_EXECUTION_TOP_N/);
		expect(() => parseConfig({ ...base, SUBSOLVER_BEARER: "invalid token" })).toThrow(
			/SUBSOLVER_BEARER/,
		);
	});

	it("requires a nonempty bearer token", () => {
		expect(() => parseConfig(base)).toThrow(/SUBSOLVER_BEARER/);
		expect(() => parseConfig({ ...base, SUBSOLVER_BEARER: "" })).toThrow(/SUBSOLVER_BEARER/);
	});
	it("passes the token to the solve listener", () => {
		expect(parseConfig({ ...base, SUBSOLVER_BEARER: "secret" })).toMatchObject({
			discoveryMethod: "solve",
			subsolverBearer: "secret",
		});
	});
	it("does not require a token for polling", () => {
		expect(
			parseConfig({ ...base, DISCOVERY_METHOD: "orderbook", DISCOVERY_URL: "http://orderbook" })
				.discoveryMethod,
		).toBe("orderbook");
	});
});

describe("correlated slippage config", () => {
	it("defaults to 5 bps without requiring the environment variable", () => {
		expect(parseConfig({ ...base, SUBSOLVER_BEARER: "secret" }).correlatedSlippageBps).toBe(5);
	});

	it.each([0, 7, 10_000])("accepts %i bps", (bps) => {
		expect(
			parseConfig({ ...base, SUBSOLVER_BEARER: "secret", CORRELATED_SLIPPAGE_BPS: String(bps) })
				.correlatedSlippageBps,
		).toBe(bps);
	});

	it.each(["-1", "10001", "1.5", "invalid", "Infinity"])("rejects invalid slippage %s", (bps) => {
		expect(() =>
			parseConfig({ ...base, SUBSOLVER_BEARER: "secret", CORRELATED_SLIPPAGE_BPS: bps }),
		).toThrow(/CORRELATED_SLIPPAGE_BPS/);
	});
});
