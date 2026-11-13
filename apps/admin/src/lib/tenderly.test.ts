import { describe, expect, it, vi } from "vitest";
import {
	createTenderlySimulation,
	isTenderlyCredentials,
	type SimulationParams,
	simulationRequest,
} from "./tenderly";

const credentials = { account: "byos", project: "debug", accessKey: "secret-test-key" };
const params: SimulationParams = {
	chainId: 100,
	blockNumber: "12345678",
	timestamp: 1700000000,
	from: `0x${"11".repeat(20)}`,
	to: `0x${"22".repeat(20)}`,
	calldata: `0x${"ab".repeat(100_000)}`,
	stateOverrides: {
		"0xauth": { code: "0x6000" },
		"0xescrow": { stateDiff: { "0xslot": "0x01" } },
	},
};

describe("Tenderly saved simulation", () => {
	it("sends large calldata in the POST body and returns a short link even for a revert", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ simulation: { id: "simulation-id", status: false } }));
		const url = await createTenderlySimulation(credentials, params, fetcher);
		expect(url).toBe("https://dashboard.tenderly.co/byos/debug/simulator/simulation-id");
		expect(url.length).toBeLessThan(100);
		const [endpoint, options] = fetcher.mock.calls[0]!;
		expect(String(endpoint)).not.toContain(params.calldata);
		expect(options?.method).toBe("POST");
		expect(options?.headers).toMatchObject({ "X-Access-Key": credentials.accessKey });
		expect(JSON.parse(options?.body as string)).toMatchObject({
			input: params.calldata,
			save: true,
			save_if_fails: true,
			network_id: "100",
			block_number: 12345678,
			block_header: { timestamp: "0x6553f100" },
			state_objects: {
				"0xauth": { code: "0x6000" },
				"0xescrow": { storage: { "0xslot": "0x01" } },
			},
		});
		expect(url).not.toContain(credentials.accessKey);
	});

	it("supports historical records without overrides", () => {
		expect(simulationRequest({ ...params, stateOverrides: undefined }).state_objects).toEqual({});
	});

	it.each([401, 403, 429, 500])(
		"reports HTTP %s without exposing upstream bodies or keys",
		async (status) => {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(credentials.accessKey, { status }));
			await expect(createTenderlySimulation(credentials, params, fetcher)).rejects.toThrow(
				/Tenderly/,
			);
			await expect(createTenderlySimulation(credentials, params, fetcher)).rejects.not.toThrow(
				credentials.accessKey,
			);
		},
	);

	it("rejects missing or invalid simulation IDs", async () => {
		for (const response of [{}, { simulation: { id: "../bad" } }]) {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
			await expect(createTenderlySimulation(credentials, params, fetcher)).rejects.toThrow(
				"did not return a saved simulation",
			);
		}
	});

	it("rejects imprecise block numbers", () => {
		expect(() => simulationRequest({ ...params, blockNumber: "9007199254740993" })).toThrow(
			"block number",
		);
	});

	it("validates browser credentials before using them", () => {
		expect(isTenderlyCredentials(credentials)).toBe(true);
		for (const value of [
			null,
			{},
			{ ...credentials, project: "../project" },
			{ ...credentials, project: ".." },
			{ ...credentials, accessKey: "" },
			{ ...credentials, accessKey: "key\r\nheader" },
		]) {
			expect(isTenderlyCredentials(value)).toBe(false);
		}
	});
});
