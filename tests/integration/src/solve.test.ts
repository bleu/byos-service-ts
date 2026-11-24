import { acceptAll } from "@byos/byos/src/domain/validator.js";
import type { Auction, SolveResponse } from "@byos/byos/src/infra/api/types.js";
import * as store from "@byos/byos/src/infra/storage.js";
import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestApp,
	readAuthHeader,
	seedCandidate,
	signAndSubmitProposal,
	type TestApp,
} from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

function emptyAuction(overrides?: Partial<Auction>): Auction {
	return {
		id: "1",
		tokens: {},
		orders: [],
		effectiveGasPrice: "10000000000",
		deadline: new Date().toISOString(),
		...overrides,
	};
}

async function postSolve(
	auction: Auction,
	testApp = app,
): Promise<{ status: number; body: SolveResponse }> {
	const resp = await testApp.internalApp.request("/solve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(auction),
	});
	return { status: resp.status, body: await resp.json() };
}

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1";
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/** An auction holding one solvable sell order for `orderUid`. */
function solvableAuction(orderUid: string, overrides?: Partial<Auction>): Auction {
	return emptyAuction({
		tokens: {
			// 1 ETH per 1e18 atoms for both tokens
			[SELL_TOKEN]: {
				referencePrice: "1000000000000000000",
				availableBalance: "0",
				trusted: false,
			},
			[BUY_TOKEN]: { referencePrice: "1000000000000000000", availableBalance: "0", trusted: false },
		},
		orders: [
			{
				uid: orderUid,
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: (10n ** 18n).toString(),
				fullSellAmount: (10n ** 18n).toString(),
				buyAmount: (10n ** 18n).toString(),
				fullBuyAmount: (10n ** 18n).toString(),
				validTo: 4294967295,
				kind: "sell",
				owner: "0x0000000000000000000000000000000000000000",
				partiallyFillable: false,
				preInteractions: [],
				postInteractions: [],
				sellTokenSource: "erc20",
				buyTokenDestination: "erc20",
				class: "limit",
				appData: `0x${"00".repeat(32)}`,
				signingScheme: "eip712",
				signature: "0x",
			},
		],
		...overrides,
	});
}

/** Submits a proposal with 1e18 surplus for `orderUid` and simulates it. */
async function seedSimulatedProposal(
	nonce: bigint,
	orderUid: `0x${string}`,
	buyAmount = 2n * 10n ** 18n,
): Promise<number> {
	return seedCandidate(app, {
		orderUid,
		nonce,
		sellAmount: 10n ** 18n,
		minBuyAmount: buyAmount,
		quoteBuyAmount: buyAmount,
		sellToken: SELL_TOKEN as Address,
		buyToken: BUY_TOKEN as Address,
		gasUsed: 150_000n,
		trampoline: "0x0000000000000000000000000000000000001234" as Address,
		simulationBuyAmount: buyAmount,
		status: "submitted",
		auctionId: 1,
	});
}

describe("/solve", () => {
	it("retains successful diagnostics only for driver submissions and preserves them after a revert", async () => {
		const params = {
			chainId: 1,
			blockNumber: "1000",
			timestamp: 1700000000,
			from: "0x0000000000000000000000000000000000000001",
			to: "0x0000000000000000000000000000000000000002",
			calldata: `0x${"ab".repeat(100_000)}`,
			stateOverrides: {},
		};
		const isolated = await createTestApp({
			validator: {
				async validate(proposal) {
					const verdict = await acceptAll.validate(proposal);
					if (verdict?.kind !== "accept" || !verdict.simulation)
						throw new Error("expected simulation");
					return {
						kind: "accept",
						simulation: { ...verdict.simulation, simulationParams: params },
					};
				},
			},
		});
		try {
			const uid = `0x${"81".repeat(56)}` as const;
			const submit = async (quote: bigint) => {
				const { response } = await signAndSubmitProposal(isolated.publicApp, {
					orderUid: uid,
					sellToken: SELL_TOKEN as Address,
					buyToken: BUY_TOKEN as Address,
					sellAmount: 10n ** 18n,
					minBuyAmount: quote,
					quoteBuyAmount: quote,
				});
				expect(response.status).toBe(200);
				return (await response.json()).id as number;
			};
			const winner = await submit(3n * 10n ** 18n);
			const loser = await submit(2n * 10n ** 18n);
			expect(await store.getIncludingLog(isolated.ctx.db, winner)).toBeNull();
			expect(isolated.candidateStore.get(winner)?.simulationParams).toEqual(params);
			const { body } = await postSolve(solvableAuction(uid), isolated);
			expect(body.solutions.map((s) => s.id)).toEqual([winner]);
			expect(
				(await store.getIncludingLog(isolated.ctx.db, winner))?.simulationFailureParams,
			).toEqual(params);
			expect(
				(await store.getIncludingLog(isolated.ctx.db, loser))?.simulationFailureParams,
			).toBeNull();

			const txHash = `0x${"cc".repeat(32)}`;
			const notify = await isolated.internalApp.request("/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					auctionId: "1",
					solutionId: winner,
					kind: "revert",
					transaction: txHash,
				}),
			});
			expect(notify.status).toBe(200);
			const response = await isolated.publicApp.request(`/proposal/${winner}`, {
				headers: { "X-Signature": await readAuthHeader() },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				id: winner,
				orderUid: uid,
				status: "settleFailed",
				settlementTxHash: txHash,
				simulationFailureParams: params,
			});
		} finally {
			await isolated.ctx.cleanup();
		}
	});

	it("waits for competition until 200 ms before the deadline despite full coverage", async () => {
		const uid = `0x${"71".repeat(56)}` as const;
		await seedSimulatedProposal(710n, uid);
		const deadline = Date.now() + 800;
		let completed = false;
		const pending = postSolve(
			solvableAuction(uid, { deadline: new Date(deadline).toISOString() }),
		).then((result) => {
			completed = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(completed).toBe(false);
		await seedSimulatedProposal(711n, uid, 3n * 10n ** 18n);
		const { body } = await pending;
		expect(Date.now()).toBeGreaterThanOrEqual(deadline - 220);
		expect(Date.now()).toBeLessThan(deadline);
		expect(body.solutions).toHaveLength(1);
		expect(body.solutions[0]?.prices[SELL_TOKEN]).toBe((3n * 10n ** 18n).toString());
	});

	it("returns partial coverage at the selection deadline", async () => {
		const uid = `0x${"72".repeat(56)}` as const;
		const missingUid = `0x${"73".repeat(56)}`;
		await seedSimulatedProposal(720n, uid);
		const deadline = Date.now() + 800;
		const auction = solvableAuction(uid, { deadline: new Date(deadline).toISOString() });
		const missingOrder = solvableAuction(missingUid).orders[0];
		if (!missingOrder) throw new Error("missing order fixture");
		auction.orders.push(missingOrder);
		const { status, body } = await postSolve(auction);
		expect(status).toBe(200);
		expect(Date.now()).toBeGreaterThanOrEqual(deadline - 220);
		expect(Date.now()).toBeLessThan(deadline);
		expect(body.solutions).toHaveLength(1);
		expect(body.solutions[0]?.trades[0]?.order).toBe(uid);
	});

	it("empty auction returns empty solutions", async () => {
		const { status, body } = await postSolve(emptyAuction());
		expect(status).toBe(200);
		expect(body.solutions).toHaveLength(0);
	});

	it("publishes gas price from auction", async () => {
		await postSolve(emptyAuction({ effectiveGasPrice: "42000000000" }));
		expect(await store.latestAuctionGasPrice(app.ctx.db, 0n)).toBe(42_000_000_000n);
	});

	it("a gas price that does not fit u64 leaves the previous one in place", async () => {
		await postSolve(emptyAuction({ effectiveGasPrice: "42000000000" }));
		await postSolve(emptyAuction({ effectiveGasPrice: (2n ** 64n).toString() }));
		expect(await store.latestAuctionGasPrice(app.ctx.db, 0n)).toBe(42_000_000_000n);
	});

	it("returns solution for active proposal with gasUsed", async () => {
		// Proposal: sell 1e18, buy 2e18 (surplus = 1e18 buy tokens); order minimum: buy 1e18
		const orderUid = `0x${"ab".repeat(56)}` as const;
		await seedSimulatedProposal(500n, orderUid);

		const { status, body } = await postSolve(solvableAuction(orderUid));
		expect(status).toBe(200);
		expect(body.solutions.length).toBeGreaterThanOrEqual(1);

		const solution = body.solutions[0];
		if (!solution) throw new Error("expected a solution");
		expect(solution.trades).toHaveLength(1);
		expect(solution.interactions.length).toBeGreaterThanOrEqual(2); // transfer + execute
		expect(solution.gas).toBeGreaterThan(0);
	});

	it("malformed auction body returns 400", async () => {
		const { status } = await postSolve({ ...emptyAuction(), orders: "nope" } as never);
		expect(status).toBe(400);
	});

	it("invalid JSON returns 400", async () => {
		const resp = await app.internalApp.request("/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(resp.status).toBe(400);
	});

	it("a quote auction (no id) is answered without recording attribution", async () => {
		const orderUid = `0x${"cd".repeat(56)}` as const;
		const id = await seedSimulatedProposal(501n, orderUid);

		const { status, body } = await postSolve(solvableAuction(orderUid, { id: undefined }));
		expect(status).toBe(200);
		expect(body.solutions).toHaveLength(1);

		// Quote requests are never settled, so nothing was attributed —
		// in particular no row under the synthetic auction id 0.
		expect(await store.get(app.ctx.db, id)).toBeNull();
		expect(app.candidateStore.get(id)).toBeDefined();
	});

	it("a non-decimal auction id is rejected", async () => {
		const { status } = await postSolve(emptyAuction({ id: "12.5" }));
		expect(status).toBe(400);
	});

	it("internal healthz returns 200", async () => {
		const resp = await app.internalApp.request("/healthz");
		expect(resp.status).toBe(200);
	});
});

describe("same-sub-solver alternatives", () => {
	it("simulates alternatives independently and selects by delivered output and gas rather than arrival order", async () => {
		const validated: bigint[] = [];
		const local = await createTestApp({
			validator: {
				validate: async (proposal) => {
					validated.push(proposal.nonce);
					if (proposal.nonce === 7002n) return { kind: "simFailed", revertReason: "bad route" };
					const verdict = await acceptAll.validate(proposal);
					if (verdict.kind !== "accept" || !verdict.simulation)
						throw new Error("expected simulation");
					return {
						kind: "accept",
						simulation: {
							...verdict.simulation,
							gasUsed: proposal.nonce === 7000n ? 100_000n : 200_000n,
							simulationBuyAmount: proposal.nonce === 7000n ? 11n * 10n ** 17n : 2n * 10n ** 18n,
						},
					};
				},
			},
		});
		try {
			const orderUid = `0x${"71".repeat(56)}` as const;
			const ids: number[] = [];
			for (const [nonce, amount] of [
				[7000n, 3n],
				[7001n, 2n],
				[7002n, 4n],
			] as const) {
				const { response } = await signAndSubmitProposal(local.publicApp, {
					orderUid,
					nonce,
					sellToken: SELL_TOKEN,
					buyToken: BUY_TOKEN,
					sellAmount: 10n ** 18n,
					minBuyAmount: 10n ** 18n,
					quoteBuyAmount: amount * 10n ** 18n,
				});
				if (nonce === 7002n) {
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({
						kind: "ProposalRejected",
						description: "SimFailed",
					});
				} else {
					expect(response.status).toBe(200);
					ids.push((await response.json()).id);
				}
			}
			expect(validated).toEqual([7000n, 7001n, 7002n]);
			const auth = await readAuthHeader();
			for (const id of ids) {
				const response = await local.publicApp.request(`/proposal/${id}`, {
					headers: { "X-Signature": auth },
				});
				expect((await response.json()).status).toBe("candidate");
			}
			const { body, status } = await postSolve(solvableAuction(orderUid), local);
			expect(status).toBe(200);
			expect(body.solutions).toHaveLength(1);
			expect(body.solutions[0]?.id).toBe(ids[1]);
			expect((await store.get(local.ctx.db, ids[1]!))?.status).toBe("submitted");
		} finally {
			await local.ctx.cleanup();
		}
	});

	it("cancels only the explicitly signed proposal and keeps its sibling eligible", async () => {
		const local = await createTestApp();
		try {
			const orderUid = `0x${"72".repeat(56)}` as const;
			const ids: number[] = [];
			for (const nonce of [7100n, 7101n, 7102n]) {
				const { response } = await signAndSubmitProposal(local.publicApp, {
					orderUid,
					nonce,
					sellToken: SELL_TOKEN,
					buyToken: BUY_TOKEN,
					sellAmount: 10n ** 18n,
					minBuyAmount: 2n * 10n ** 18n,
					quoteBuyAmount: 2n * 10n ** 18n,
				});
				ids.push((await response.json()).id);
			}
			const { cancelSignatureHeader } = await import("./helpers.js");
			const signature = await cancelSignatureHeader(ids[1]!);
			const cancel = await local.publicApp.request(`/proposal/${ids[1]}`, {
				method: "DELETE",
				headers: { "X-Signature": signature },
			});
			expect(cancel.status).toBe(204);
			const auth = await readAuthHeader();
			const states = await Promise.all(
				ids.map(async (id) => {
					const response = await local.publicApp.request(`/proposal/${id}`, {
						headers: { "X-Signature": auth },
					});
					return (await response.json()).status;
				}),
			);
			expect(states).toEqual(["candidate", "cancelled", "candidate"]);
			const { body } = await postSolve(solvableAuction(orderUid), local);
			expect(body.solutions).toHaveLength(1);
			expect(body.solutions[0]?.id).toBe(ids[0]);
		} finally {
			await local.ctx.cleanup();
		}
	});

	it("keeps both alternatives when an older submission finishes validation last", async () => {
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const local = await createTestApp({
			validator: {
				validate: async (proposal) => {
					if (proposal.nonce === 7200n) {
						entered();
						await gate;
					}
					return acceptAll.validate(proposal);
				},
			},
		});
		try {
			const orderUid = `0x${"73".repeat(56)}` as const;
			const first = signAndSubmitProposal(local.publicApp, { orderUid, nonce: 7200n });
			await started;
			const second = await signAndSubmitProposal(local.publicApp, { orderUid, nonce: 7201n });
			release();
			const older = await first;
			expect(older.response.status).toBe(200);
			expect(second.response.status).toBe(200);
			const auth = await readAuthHeader();
			const response = await local.publicApp.request(`/proposals/${orderUid}`, {
				headers: { "X-Signature": auth },
			});
			const body = await response.json();
			expect(body.proposals).toHaveLength(2);
			expect(body.proposals.every((p: { status: string }) => p.status === "candidate")).toBe(true);
			const { otherReadAuthHeader } = await import("./helpers.js");
			const other = await local.publicApp.request(`/proposals/${orderUid}`, {
				headers: { "X-Signature": await otherReadAuthHeader() },
			});
			expect((await other.json()).proposals).toHaveLength(0);
			const archived = await local.publicApp.request(
				`/proposals/${orderUid}?includeArchived=true`,
				{
					headers: { "X-Signature": auth },
				},
			);
			expect((await archived.json()).proposals).toHaveLength(0);
		} finally {
			release();
			await local.ctx.cleanup();
		}
	});
});
