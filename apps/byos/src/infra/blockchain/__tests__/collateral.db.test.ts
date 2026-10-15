import { type CowOrder, OrderKind, OrderStatus, SigningScheme, TrampolineAbi } from "@byos/common";
import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	type PublicClient,
} from "viem";
import { expect, it } from "vitest";
import { createTestDb } from "../../../../test/setup.js";
import * as store from "../../storage.js";
import { SimulationValidator } from "../validator.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const BUY = "0x2222222222222222222222222222222222222222" as Address;
const SCALE = 10n ** 18n;

it("admits pending siblings independently using persisted active exposure", async () => {
	const ctx = await createTestDb();
	try {
		const insert = async (nonce: bigint) => {
			const orderUid = `0x${nonce.toString(16).padStart(2, "0").repeat(56)}`;
			const { id } = await store.insert(ctx.db, {
				subSolver: ADDRESS,
				orderUid,
				orderUidHash: `0x${"aa".repeat(32)}`,
				sellAmount: SCALE,
				minBuyAmount: SCALE,
				quoteBuyAmount: SCALE,
				sellToken: ADDRESS,
				buyToken: BUY,
				interactions: [],
				interactionsHash: `0x${"bb".repeat(32)}`,
				validUntil: 2_000_000_000n,
				nonce,
				signature: "0x",
				status: "submitted",
				rejectionReason: null,
				gasUsed: null,
				trampoline: ADDRESS,
				settlementTxHash: null,
				penaltyTxHash: null,
				pendingCancellation: false,
				sellTokenRefPrice: null,
				surplusTokenRefPrice: null,
				auctionGasPrice: null,
				clearingPrices: null,
				simulationBuyAmount: null,
			});
			return (await store.get(ctx.db, id))!;
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
			readContract: async (args: { functionName: string }) =>
				args.functionName === "effectiveBalance" ? 500_000_000_000_000n : ADDRESS,
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
		const validator = new SimulationValidator(
			client,
			{
				order: async () => ({
					order,
					preInteractions: [],
					postInteractions: [],
					erc20Balances: true,
					status: OrderStatus.OPEN,
				}),
				nativePrice: async () => SCALE,
			},
			ADDRESS,
			ADDRESS,
			ADDRESS,
			{ value: 1n },
			0n,
			100n,
			SCALE,
			4n,
			SCALE / 100n,
			(subSolver, current) => store.fetchInflightDataBySubSolver(ctx.db, subSolver, current),
		);
		const a = await insert(1n);
		const b = await insert(2n);
		const accepted = await validator.validate(a);
		expect(accepted?.kind).toBe("accept");
		await store.resolveVerdict(ctx.db, a.id, accepted!);
		const blocked = await validator.validate(b);
		expect(blocked).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
		// Once A leaves the live exposure set, B is eligible without resubmission.
		await store.transition(ctx.db, (await store.get(ctx.db, a.id))!, "cancelled");
		expect((await validator.validate(b))?.kind).toBe("accept");
	} finally {
		await ctx.cleanup();
	}
});
