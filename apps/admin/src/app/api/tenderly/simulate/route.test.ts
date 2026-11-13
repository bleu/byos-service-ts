import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProposalDetail, createTenderlySimulation } = vi.hoisted(() => ({
	getProposalDetail: vi.fn(),
	createTenderlySimulation: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/queries", () => ({ getProposalDetail }));
vi.mock("@/lib/tenderly", async () => ({
	...(await import("../../../../lib/tenderly")),
	createTenderlySimulation,
}));

import { POST } from "./route";

const credentials = { account: "byos", project: "debug", accessKey: "test-key" };
function request(body: unknown, origin = "https://admin.example", host = "admin.example") {
	// Next's internal origin can differ from the public one behind Tailscale/reverse proxies.
	return new Request("http://localhost:3000/api/tenderly/simulate", {
		method: "POST",
		headers: { origin, host, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("admin simulation endpoint", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("rejects cross-origin requests before reading the proposal or calling Tenderly", async () => {
		const response = await POST(request({ proposalId: 5, credentials }, "https://other.example"));
		expect(response.status).toBe(403);
		expect(getProposalDetail).not.toHaveBeenCalled();
		expect(createTenderlySimulation).not.toHaveBeenCalled();
	});

	it.each([{}, { proposalId: -1, credentials }, { proposalId: 5, credentials: {} }])(
		"rejects invalid input",
		async (body) => {
			expect((await POST(request(body))).status).toBe(400);
		},
	);

	it("uses saved server parameters and returns the short link behind a proxy", async () => {
		const params = { calldata: "0xabc", stateOverrides: { "0xabc": { code: "0x6000" } } };
		getProposalDetail.mockResolvedValue({ proposal: { simulationFailureParams: params } });
		createTenderlySimulation.mockResolvedValue(
			"https://dashboard.tenderly.co/byos/debug/simulator/id",
		);
		const response = await POST(request({ proposalId: 5, credentials, calldata: "untrusted" }));
		expect(response.status).toBe(200);
		expect(createTenderlySimulation).toHaveBeenCalledWith(credentials, params);
		expect(await response.json()).toEqual({
			url: "https://dashboard.tenderly.co/byos/debug/simulator/id",
		});
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("reports missing proposals and missing diagnostics without contacting Tenderly", async () => {
		getProposalDetail.mockResolvedValue(null);
		expect((await POST(request({ proposalId: 5, credentials }))).status).toBe(404);
		getProposalDetail.mockResolvedValue({ proposal: { simulationFailureParams: null } });
		expect((await POST(request({ proposalId: 5, credentials }))).status).toBe(422);
		expect(createTenderlySimulation).not.toHaveBeenCalled();
	});

	it("reports timeouts as retryable UI errors", async () => {
		getProposalDetail.mockResolvedValue({ proposal: { simulationFailureParams: {} } });
		createTenderlySimulation.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
		const response = await POST(request({ proposalId: 5, credentials }));
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "Tenderly timed out. Try again." });
	});
});
