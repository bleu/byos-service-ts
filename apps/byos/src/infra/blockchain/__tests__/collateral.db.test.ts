import { type CowOrder, OrderKind, OrderStatus, SigningScheme, TrampolineAbi } from "@byos/common";
import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	type PublicClient,
} from "viem";
import { afterEach, expect, it } from "vitest";
import { createTestDb } from "../../../../test/setup.js";
import {
	_clearLocalAuctionState,
	_patchLocalGasPrice,
	_setLocalAuctionState,
} from "../../auction-state.js";
import type { Candidate } from "../../candidate-store.js";
import * as store from "../../storage.js";
import { SimulationValidator } from "../validator.js";

afterEach(() => _clearLocalAuctionState());

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const BUY = "0x2222222222222222222222222222222222222222" as Address;
const SCALE = 10n ** 18n;

const SOLUTION_PRICES: store.SolutionPrices = {
	sellTokenRefPrice: SCALE.toString(),
	surplusTokenRefPrice: SCALE.toString(),
	auctionGasPrice: "1",
	clearingPrices: {},
};

it("admits pending siblings independently using persisted active exposure", async () => {
	const ctx = await createTestDb();
	try {
		let idCounter = 1;
		const insertSubmitted = async (nonce: bigint) => {
			const orderUid = `0x${nonce.toString(16).padStart(2, "0").repeat(56)}`;
			const candidate: Candidate = {
				id: idCounter++,
				subSolver: ADDRESS,
				orderUid,
				orderUidHash: `0x${"aa".repeat(32)}` as Hex,
				sellAmount: SCALE,
				minBuyAmount: SCALE,
				quoteBuyAmount: SCALE,
				sellToken: ADDRESS,
				buyToken: BUY,
				interactions: [],
				interactionsHash: `0x${"bb".repeat(32)}` as Hex,
				validUntil: 2_000_000_000n,
				nonce,
				signature: "0x" as Hex,
				auctionId: 1,
				gasUsed: 100_000n,
				trampoline: ADDRESS,
				simulationBuyAmount: null,
				sellTokenRefPrice: SCALE.toString(),
				createdAt: new Date(),
			};
			await store.insertAsSubmitted(ctx.db, candidate, SCALE.toString(), SOLUTION_PRICES);
			return (await store.get(ctx.db, candidate.id))!;
		};
		const order: CowOrder = {
			sellToken: ADDRESS,
			buyToken: BUY,
			receiver: ADDRESS,
			sellAmount: SCALE,
			buyAmount: SCALE / 2n,
			validTo: 2_000_000_000,
			appData: `0x${"00".repeat(32)}`,
			feeAmount: 0n,
			kind: OrderKind.SELL,
			partiallyFillable: false,
			signingScheme: SigningScheme.Eip712,
			signature: "0x",
		};
		const client = {
			multicall: async () => [{ status: "success", result: 500_000_000_000_000n }],
			readContract: async () => ADDRESS,
			request: async () => [
				{
					calls: [
						{
							status: "0x1",
							gasUsed: "0x186a0",
							returnData: "0x",
							logs: [
								{
									address: ADDRESS,
									topics: encodeEventTopics({
										abi: TrampolineAbi,
										eventName: "Executed",
										args: { _orderUidHash: `0x${"aa".repeat(32)}` as Hex },
									}),
									data: encodeAbiParameters(
										[{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
										[SCALE, 0n, 0n],
									),
								},
							],
						},
					],
				},
			],
		} as unknown as PublicClient;
		// Populate auction state so SimulationValidator can resolve order and prices.
		// insertSubmitted(1n) and insertSubmitted(2n) produce these UIDs.
		const record = {
			order,
			preInteractions: [],
			postInteractions: [],
			erc20Balances: true,
			status: OrderStatus.OPEN,
		};
		_setLocalAuctionState({
			auctionId: 1,
			orders: new Map([
				[`0x${"01".repeat(56)}`, record],
				[`0x${"02".repeat(56)}`, record],
			]),
			prices: new Map([
				[ADDRESS.toLowerCase(), SCALE],
				[BUY.toLowerCase(), SCALE],
			]),
			gasPrice: 0n,
		});
		// Gas price used for exposure calculation lives in auction state.
		_patchLocalGasPrice(1n);
		const validator = new SimulationValidator(
			client,
			ADDRESS,
			ADDRESS,
			ADDRESS,
			0n,
			100n,
			SCALE,
			4n,
			SCALE / 100n,
			(subSolver) => store.fetchInflightDataBySubSolver(ctx.db, subSolver),
		);
		const a = await insertSubmitted(1n);
		// Validate b against the exposure of a (already submitted)
		const bProposal = {
			id: idCounter++,
			subSolver: ADDRESS,
			orderUid: `0x${"02".repeat(56)}`,
			orderUidHash: `0x${"aa".repeat(32)}` as Hex,
			sellAmount: SCALE,
			minBuyAmount: SCALE,
			quoteBuyAmount: SCALE,
			sellToken: ADDRESS,
			buyToken: BUY,
			interactions: [],
			interactionsHash: `0x${"bb".repeat(32)}` as Hex,
			validUntil: 2_000_000_000n,
			nonce: 2n,
			signature: "0x" as Hex,
			status: "submitted" as const,
			rejectionReason: null,
			gasUsed: null,
			trampoline: ADDRESS,
			settlementTxHash: null,
			penaltyTxHash: null,
			simulationFailureParams: null,
			simulationBuyAmount: null,
			sellTokenRefPrice: null,
			buyTokenRefPrice: null,
			surplusTokenRefPrice: null,
			auctionGasPrice: null,
			clearingPrices: null,
			auctionId: 1,
			createdAt: new Date(),
			statusChangedAt: new Date(),
		};
		const blocked = await validator.validate(bProposal);
		expect(blocked).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
		// Once A leaves the live exposure set (cancelled), B is eligible.
		await store.transition(ctx.db, a, "cancelled");
		expect((await validator.validate(bProposal))?.kind).toBe("accept");
	} finally {
		await ctx.cleanup();
	}
});
