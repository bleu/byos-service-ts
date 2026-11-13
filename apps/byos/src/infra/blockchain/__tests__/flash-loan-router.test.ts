import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_FLASH_LOAN_ROUTER,
	FLASH_LOAN_NETWORKS_URL,
	resolveFlashLoanRouter,
} from "../flash-loan-router.js";

import networks from "./fixtures/flash-loan-networks.json" with { type: "json" };

const other = "0x1111111111111111111111111111111111111111";

describe("flash loan router deployment resolution", () => {
	// Fixture: https://github.com/cowprotocol/flash-loan-router/blob/main/networks.json
	it("parses the upstream deployment registry for every listed chain", async () => {
		for (const [chainId, deployment] of Object.entries(networks.FlashLoanRouter)) {
			const fetchNetworks = vi.fn<typeof fetch>().mockResolvedValue(Response.json(networks));
			expect(
				await resolveFlashLoanRouter(Number(chainId), undefined, undefined, fetchNetworks),
			).toBe(deployment.address);
		}
	});
	it("selects the requested chain's router, not the borrower or another chain", async () => {
		const fetchNetworks = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				AaveBorrower: { "1": { address: other } },
				FlashLoanRouter: { "1": { address: DEFAULT_FLASH_LOAN_ROUTER }, "100": { address: other } },
			}),
		);
		expect(await resolveFlashLoanRouter(100, undefined, undefined, fetchNetworks)).toBe(other);
		expect(fetchNetworks).toHaveBeenCalledWith(FLASH_LOAN_NETWORKS_URL, {
			signal: expect.any(AbortSignal),
		});
	});
	it("uses an explicit deployment without fetching", async () => {
		const fetchNetworks = vi.fn<typeof fetch>();
		expect(await resolveFlashLoanRouter(1, other, undefined, fetchNetworks)).toBe(other);
		expect(fetchNetworks).not.toHaveBeenCalled();
	});
	it.each([
		["invalid JSON", () => new Response("not json")],
		["HTTP failure", () => new Response("unavailable", { status: 503 })],
		["wrong schema", () => Response.json([])],
		["missing chain", () => Response.json({ FlashLoanRouter: {} })],
		["invalid address", () => Response.json({ FlashLoanRouter: { "1": { address: "0x123" } } })],
		[
			"zero address",
			() => Response.json({ FlashLoanRouter: { "1": { address: `0x${"0".repeat(40)}` } } }),
		],
	] as const)("falls back on %s", async (_name, response) => {
		const fetchNetworks = vi.fn<typeof fetch>().mockResolvedValue(response());
		expect(await resolveFlashLoanRouter(1, undefined, undefined, fetchNetworks)).toBe(
			DEFAULT_FLASH_LOAN_ROUTER,
		);
	});
	it("falls back on network failure or timeout", async () => {
		const fetchNetworks = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
		expect(await resolveFlashLoanRouter(1, undefined, undefined, fetchNetworks)).toBe(
			DEFAULT_FLASH_LOAN_ROUTER,
		);
	});
});
