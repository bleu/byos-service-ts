import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const base = {
	DISCOVERY_METHOD: "solve",
	BYOS_URL: "http://byos",
	RPC_URL: "http://rpc",
	SUBSOLVER_PRIVATE_KEY: "0x01",
	CHAIN_ID: "56",
	TRAMPOLINE_FACTORY: "0x0000000000000000000000000000000000000001",
	GPV2_SETTLEMENT: "0x0000000000000000000000000000000000000002",
};

describe("solve discovery config", () => {
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
