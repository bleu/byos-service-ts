import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolveConfig } from "../solve.js";
import { createSolveRoute } from "../solve.js";

vi.mock("../../storage.js", () => ({
	publishAuctionGasPrice: vi.fn(async () => {}),
}));
afterEach(() => vi.unstubAllGlobals());

describe("sub-solver forwarding", () => {
	it("forwards the raw auction with the shared bearer token", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetch);
		const app = createSolveRoute({
			db: {} as SolveConfig["db"],
			candidateStore: {} as SolveConfig["candidateStore"],
			validator: {} as SolveConfig["validator"],
			onAuditEvent: () => {},
			subsolvingEndpoints: ["http://subsolver:3001"],
			subsolverBearer: "shared-secret",
		});
		const auction = {
			id: "1",
			tokens: {},
			orders: [],
			effectiveGasPrice: "1",
			deadline: new Date().toISOString(),
		};
		const response = await app.request("/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(auction),
		});
		expect(response.status).toBe(200);
		expect(fetch).toHaveBeenCalledWith("http://subsolver:3001/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer shared-secret" },
			body: JSON.stringify(auction),
		});
	});
});
