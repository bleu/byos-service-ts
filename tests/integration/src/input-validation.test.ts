import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelSignatureHeader, createTestApp, readAuthHeader, type TestApp } from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

describe("sell/buy amount validation", () => {
	it("rejects hex sellAmount", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: `0x${"11".repeat(20)}`,
				buyToken: `0x${"22".repeat(20)}`,
				sellAmount: "0x1000",
				minBuyAmount: "900",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: `0x${"ab".repeat(65)}`,
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
		expect(body.description).toContain("sellAmount");
	});

	it("rejects hex minBuyAmount", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: `0x${"11".repeat(20)}`,
				buyToken: `0x${"22".repeat(20)}`,
				sellAmount: "1000",
				minBuyAmount: "0xff",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: `0x${"ab".repeat(65)}`,
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
		expect(body.description).toContain("minBuyAmount");
	});
});

describe("signature validation", () => {
	it("rejects non-65-byte signature (too short)", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: `0x${"11".repeat(20)}`,
				buyToken: `0x${"22".repeat(20)}`,
				sellAmount: "1000",
				minBuyAmount: "900",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: `0x${"ab".repeat(32)}`, // 32 bytes, not 65
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("InvalidSignature");
	});

	it("rejects non-65-byte signature (too long)", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: `0x${"11".repeat(20)}`,
				buyToken: `0x${"22".repeat(20)}`,
				sellAmount: "1000",
				minBuyAmount: "900",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: `0x${"ab".repeat(66)}`, // 66 bytes, not 65
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("InvalidSignature");
	});

	it("rejects odd-length hex signature", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: `0x${"ab".repeat(56)}`,
				sellToken: `0x${"11".repeat(20)}`,
				buyToken: `0x${"22".repeat(20)}`,
				sellAmount: "1000",
				minBuyAmount: "900",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: "0xabc", // odd length
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
	});
});

describe("proposal ID edge cases", () => {
	it("GET with ID above safe integer returns 400", async () => {
		const sig = await readAuthHeader();
		const resp = await app.publicApp.request("/proposal/99999999999999999999", {
			method: "GET",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(400);
	});

	it("DELETE with ID above safe integer returns 400", async () => {
		const sig = await cancelSignatureHeader(0);
		const resp = await app.publicApp.request("/proposal/99999999999999999999", {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(400);
	});

	it("GET with fractional ID returns 400", async () => {
		const sig = await readAuthHeader();
		const resp = await app.publicApp.request("/proposal/1.5", {
			method: "GET",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(400);
	});

	it("GET with negative ID returns 400", async () => {
		const sig = await readAuthHeader();
		const resp = await app.publicApp.request("/proposal/-1", {
			method: "GET",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(400);
	});
});
