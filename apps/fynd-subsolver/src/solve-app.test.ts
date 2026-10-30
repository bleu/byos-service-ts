import { SolveOrderbookClient } from "@byos/subsolver-core";
import { describe, expect, it, vi } from "vitest";
import { createSolveApp } from "./solve-app.js";

describe("solve discovery authentication", () => {
	it.each([
		[undefined, 401],
		["Bearer wrong", 401],
		["Basic secret", 400],
	] as const)("rejects %s without replacing orders", async (authorization, status) => {
		const client = new SolveOrderbookClient();
		const receive = vi.spyOn(client, "receive");
		const app = createSolveApp(client, "secret");
		const response = await app.request("/solve", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: JSON.stringify({ orders: [] }),
		});
		expect(response.status).toBe(status);
		expect(receive).not.toHaveBeenCalled();
	});

	it("accepts an authenticated auction", async () => {
		const client = new SolveOrderbookClient();
		const receive = vi.spyOn(client, "receive");
		const app = createSolveApp(client, "secret");
		const response = await app.request("/solve", {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ orders: [] }),
		});
		expect(response.status).toBe(200);
		expect(receive).toHaveBeenCalledWith({ orders: [] });
	});
});
