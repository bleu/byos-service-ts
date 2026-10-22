import type { Address, WalletClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	submitProposalBurstUntilSettled,
	submitProposalInAuction,
	submitProposalUntilTrade,
} from "../byos.js";

vi.mock("@byos/common", () => ({
	byosDomain: vi.fn(),
	signProposal: vi.fn().mockResolvedValue("0x1234"),
	signReadAuth: vi.fn().mockResolvedValue("0x1234"),
	signCancellation: vi.fn().mockResolvedValue("0x1234"),
}));

const params = {
	walletClient: {} as WalletClient,
	orderUid: `0x${"11".repeat(56)}`,
	sellToken: `0x${"22".repeat(20)}` as Address,
	buyToken: `0x${"33".repeat(20)}` as Address,
	sellAmount: 100n,
	minBuyAmount: 90n,
	quoteBuyAmount: 100n,
	interactions: [],
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("proposal auction retries", () => {
	it("retries admission, replaces a closed-auction proposal, and stops during execution", async () => {
		vi.useFakeTimers();
		const submissions: { nonce: string }[] = [];
		let tick = 0;
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("/trades?")) {
				tick++;
				return Response.json(tick >= 6 ? [{}] : []);
			}
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (input.endsWith("/auction")) {
				return Response.json({ id: tick < 4 ? 1 : 2, orders: [{ uid: params.orderUid }] });
			}
			if (init?.method === "POST") {
				submissions.push(JSON.parse(String(init.body)));
				if (submissions.length === 1)
					return Response.json({ kind: "UnknownOrder" }, { status: 400 });
				return Response.json({ id: submissions.length });
			}
			if (input.endsWith("/proposal/2")) {
				return Response.json({
					status: tick < 4 ? "active" : "rejected",
					rejectionReason: "AuctionClosed",
				});
			}
			return Response.json({ status: tick < 6 ? "executing" : "settled" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = submitProposalUntilTrade(params, 10_000);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toEqual({ id: 3 });
		expect(submissions).toHaveLength(3);
		expect(new Set(submissions.map((body) => body.nonce)).size).toBe(3);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
	});

	it("bounds admission retries and reports the last error", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (input.includes("/trades?")) return Response.json([]);
				if (input.endsWith("/auction"))
					return Response.json({ id: 1, orders: [{ uid: params.orderUid }] });
				return Response.json({ kind: "NoActiveAuction" }, { status: 400 });
			}),
		);
		const result = expect(submitProposalUntilTrade(params, 1_000)).rejects.toThrow(
			"NoActiveAuction",
		);
		await vi.runAllTimersAsync();
		await result;
	});

	it("surfaces validation failures instead of retrying them", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (input.includes("/trades?")) return Response.json([]);
				if (input.endsWith("/auction"))
					return Response.json({ id: 1, orders: [{ uid: params.orderUid }] });
				return Response.json(
					{ kind: "ProposalRejected", description: "Unprofitable" },
					{ status: 400 },
				);
			}),
		);
		await expect(submitProposalUntilTrade(params)).rejects.toThrow("Unprofitable");
	});
});

describe("inline rejection and burst admission", () => {
	it("retries admission races but exposes a real inline rejection", async () => {
		vi.useFakeTimers();
		let posts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				if (init?.method !== "POST")
					return Response.json({ id: 1, orders: [{ uid: params.orderUid }] });
				posts++;
				return Response.json(
					posts === 1
						? { kind: "UnknownOrder" }
						: { kind: "ProposalRejected", description: "SimFailed" },
					{ status: 400 },
				);
			}),
		);
		const result = submitProposalInAuction(params);
		await vi.runAllTimersAsync();
		expect((await result).response.status).toBe(400);
		expect(await (await result).response.json()).toMatchObject({ description: "SimFailed" });
		expect(posts).toBe(2);
	});

	it("refreshes burst proposals across auctions and avoids cancelling terminal attempts", async () => {
		vi.useFakeTimers();
		let tick = 0;
		let posts = 0;
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("by-sub-solver")) {
				tick++;
				return Response.json({
					proposals: [
						...(posts > 0 ? [{ id: 1, status: tick >= 3 ? "cancelled" : "active" }] : []),
						...(posts > 1 ? [{ id: 2, status: tick >= 5 ? "settled" : "executing" }] : []),
					],
				});
			}
			if (input.endsWith("/auction"))
				return Response.json({ id: tick >= 3 ? 2 : 1, orders: [{ uid: params.orderUid }] });
			if (init?.method === "POST") return Response.json({ id: ++posts });
			throw new Error(`Unexpected request ${init?.method} ${input}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const assignment = { params, subSolverIndex: 0, winner: true };
		const result = submitProposalBurstUntilSettled([assignment], 10_000, vi.fn());
		await vi.runAllTimersAsync();
		await expect(result).resolves.toEqual([{ ...assignment, id: 2 }]);
		expect(posts).toBe(2);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
	});
	it("does not issue a cancellation storm for a large settled burst", async () => {
		vi.useFakeTimers();
		const assignments = Array.from({ length: 1000 }, (_, index) => ({
			params: { ...params, orderUid: `0x${(index + 1).toString(16).padStart(112, "0")}` },
			subSolverIndex: 0,
			winner: true,
		}));
		let posts = 0;
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("by-sub-solver"))
				return Response.json({
					proposals: Array.from({ length: posts }, (_, index) => ({
						id: index + 1,
						status: "settled",
					})),
				});
			if (input.endsWith("/auction"))
				return Response.json({
					id: 1,
					orders: assignments.map(({ params }) => ({ uid: params.orderUid })),
				});
			if (init?.method === "POST") return Response.json({ id: ++posts });
			throw new Error(`Unexpected cleanup request ${init?.method}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = submitProposalBurstUntilSettled(assignments, 10_000, vi.fn());
		await vi.runAllTimersAsync();
		expect(await result).toHaveLength(1000);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
	});
});
