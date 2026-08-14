import { type CowOrder, encodeSettle, OrderKind, SigningScheme } from "@byos/common";
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "../../../domain/order.js";
import type { Proposal } from "../../../domain/proposal.js";
import type { FetchOrder } from "../../orderbook.js";
import { DUMMY_SUBMITTER } from "../simulation.js";
import { SimulationValidator } from "../validator.js";

const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const ESCROW = "0x1111111111111111111111111111111111111234";
const TRAMPOLINE_FACTORY = "0x2222222222222222222222222222222222221234";
const AUTHENTICATOR = "0x3333333333333333333333333333333333331234";
const ETHER = 10n ** 18n;

function sampleOrder(overrides?: Partial<CowOrder>): CowOrder {
	return {
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		receiver: "0xd2e80D60aff5377587E49FF32c9bad639d6f68Bc",
		sellAmount: 1_000_000n,
		buyAmount: 990_000n,
		validTo: 1_700_000_000,
		appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
		feeAmount: 0n,
		kind: OrderKind.SELL,
		partiallyFillable: false,
		signingScheme: SigningScheme.Eip712,
		signature: `0x${"ab".repeat(65)}`,
		...overrides,
	};
}

function sampleRecord(order: CowOrder): OrderRecord {
	return {
		order,
		preInteractions: [],
		postInteractions: [],
		erc20Balances: true,
	};
}

function submittedProposal(): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}`,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		maxBuyAmount: 990_000n,
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}`,
		validUntil: 1_700_000_000n,
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}`,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		// Pre-populated so validate() never resolves the trampoline via RPC.
		trampoline: "0x4444444444444444444444444444444444441234",
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
	};
}

function fakePublicClient(): PublicClient {
	return {
		readContract: async () => AUTHENTICATOR,
		estimateGas: async () => 100_000n,
	} as unknown as PublicClient;
}

function fakeOrderbook(record: OrderRecord): FetchOrder {
	return {
		order: async () => record,
		nativePrice: async () => ETHER, // 1:1 — surplus in atoms equals surplus in wei
	};
}

function validatorWith(record: OrderRecord, minScore: bigint): SimulationValidator {
	return new SimulationValidator(
		fakePublicClient(),
		fakeOrderbook(record),
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		{ value: 0n }, // zero gas price: score is exactly the priced surplus
		minScore,
	);
}

const TRAMPOLINE = "0x4444444444444444444444444444444444441234";

interface FakeNode {
	client: PublicClient;
	counts: { addressOf: number; estimateGas: number };
	estimateCalls: Array<Record<string, unknown>>;
}

/**
 * Fake RPC client mirroring the Rust test node: answers the address getters
 * (factory → trampoline, settlement → authenticator) and eth_estimateGas
 * with 100_000 gas, unless a step is overridden to fail.
 */
function fakeNode(opts?: {
	estimateGas?: () => Promise<bigint>;
	addressOf?: () => Promise<string>;
}): FakeNode {
	const counts = { addressOf: 0, estimateGas: 0 };
	const estimateCalls: Array<Record<string, unknown>> = [];
	const client = {
		readContract: async (args: { functionName: string }) => {
			if (args.functionName === "addressOf") {
				counts.addressOf += 1;
				return opts?.addressOf ? await opts.addressOf() : TRAMPOLINE;
			}
			return AUTHENTICATOR;
		},
		estimateGas: async (args: Record<string, unknown>) => {
			counts.estimateGas += 1;
			estimateCalls.push(args);
			return opts?.estimateGas ? await opts.estimateGas() : 100_000n;
		},
	} as unknown as PublicClient;
	return { client, counts, estimateCalls };
}

function validatorAt(
	node: FakeNode,
	orderbook: FetchOrder,
	gasPrice = 0n,
	minScore = 0n,
): SimulationValidator {
	return new SimulationValidator(
		node.client,
		orderbook,
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		{ value: gasPrice },
		minScore,
	);
}

describe("SimulationValidator profitability gate", () => {
	it("zero-surplus first simulation rejects as unprofitable", async () => {
		// Order limit equal to the proposal's buy amount: zero surplus. With a
		// zero gas price the score is exactly 0, which must NOT exceed the
		// default minScore of 0 — score must be strictly greater.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.maxBuyAmount }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score exactly at a nonzero minScore rejects", async () => {
		// Surplus of 10_000 atoms priced 1:1 scores exactly 10_000.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.maxBuyAmount - 10_000n }));

		const verdict = await validatorWith(record, 10_000n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score above minScore accepts", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.maxBuyAmount - 10_000n }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toMatchObject({ kind: "accept" });
	});
});

describe("SimulationValidator", () => {
	it("simulation dispatches full settle with overrides", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.maxBuyAmount - 10_000n }));
		const node = fakeNode();

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);
		expect(verdict).toMatchObject({
			kind: "accept",
			simulation: {
				gasUsed: 100_000n,
				trampoline: proposal.trampoline,
				sellToken: record.order.sellToken,
				buyToken: record.order.buyToken,
			},
		});

		// The transaction: dummy submitter → settlement, carrying the exact
		// settle() calldata the encoder produces for these inputs.
		expect(node.estimateCalls).toHaveLength(1);
		const call = node.estimateCalls[0] as Record<string, unknown>;
		expect(call.account).toBe(DUMMY_SUBMITTER);
		expect(call.to).toBe(SETTLEMENT);
		expect(call.data).toBe(
			encodeSettle(
				record.order,
				{
					orderUidHash: proposal.orderUidHash,
					sellAmount: proposal.sellAmount,
					minBuyAmount: proposal.minBuyAmount,
					maxBuyAmount: proposal.maxBuyAmount,
					validUntil: proposal.validUntil,
					nonce: proposal.nonce,
				},
				proposal.trampoline as Address,
				proposal.interactions,
				proposal.signature,
				record.preInteractions,
				record.postInteractions,
			),
		);

		// The state overrides: AnyoneAuthenticator code at the authenticator,
		// SUBMITTER_ROLE state_diff on the escrow at the pinned slot-5 slot.
		const overrides = call.stateOverride as Array<{
			address: string;
			code?: string;
			stateDiff?: Array<{ slot: string; value: string }>;
		}>;
		const auth = overrides.find((o) => o.address === AUTHENTICATOR);
		expect(auth?.code).toMatch(/^0x6080/);
		const escrow = overrides.find((o) => o.address === ESCROW);
		expect(escrow?.stateDiff?.[0]?.slot).toBe(
			"0x4eb8c5e0e8f6947fc61867e46604b89f6f2511c7f24d1be62be922d32b056655",
		);
		expect(escrow?.stateDiff?.[0]?.value.endsWith("1")).toBe(true);
	});

	it("buy order gate prices the sell token", async () => {
		// A buy order around the same proposal: exact buy amount (the envelope
		// requirement), sell limit above the proposal's so the pair carries
		// surplus — in the sell token. Only the sell token is priced: if the
		// gate wrongly priced the buy token it would see NotFound and reject
		// as Unprofitable.
		const proposal = submittedProposal();
		const order = sampleOrder({
			kind: OrderKind.BUY,
			buyAmount: proposal.maxBuyAmount,
			sellAmount: proposal.sellAmount + 100_000n,
		});
		const pricedOnly: FetchOrder = {
			order: async () => sampleRecord(order),
			nativePrice: async (token) => {
				if (token.toLowerCase() === order.sellToken.toLowerCase()) return ETHER;
				throw { kind: "notFound" };
			},
		};

		const verdict = await validatorAt(fakeNode(), pricedOnly).validate(proposal);
		expect(verdict).toMatchObject({ kind: "accept" });
	});

	it("revalidation of an active proposal skips the profitability gate", async () => {
		// 1 gwei: the simulated 100k gas costs ~1.3e14 wei, dwarfing the
		// 10_000-wei surplus at parity pricing — the score is deeply negative.
		const gasPrice = 1_000_000_000n;
		const submitted = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: submitted.maxBuyAmount - 10_000n }));

		// The gate would reject these inputs on a first (Submitted) pass…
		const first = await validatorAt(fakeNode(), fakeOrderbook(record), gasPrice).validate(
			submitted,
		);
		expect(first).toEqual({ kind: "reject", reason: "Unprofitable" });

		// …but re-validation of an Active proposal must not churn it: the
		// simulation still runs (gas refresh), the gate is skipped.
		const active = { ...submittedProposal(), status: "active" as const };
		const revalidated = await validatorAt(fakeNode(), fakeOrderbook(record), gasPrice).validate(
			active,
		);
		expect(revalidated).toMatchObject({ kind: "accept" });
	});

	it("native price outage defers first verdict", async () => {
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));
		const outage: FetchOrder = {
			order: async () => record,
			nativePrice: async () => {
				throw { kind: "transient", message: "price feed down" };
			},
		};

		const verdict = await validatorAt(fakeNode(), outage).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("unknown order rejects proposal", async () => {
		const notFound: FetchOrder = {
			order: async () => {
				throw { kind: "notFound" };
			},
			nativePrice: async () => ETHER,
		};

		const verdict = await validatorAt(fakeNode(), notFound).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "OrderNotFound" });
	});

	it("orderbook outage defers judgment", async () => {
		const outage: FetchOrder = {
			order: async () => {
				throw { kind: "transient", message: "orderbook down" };
			},
			nativePrice: async () => ETHER,
		};

		const verdict = await validatorAt(fakeNode(), outage).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("out of envelope order rejects proposal", async () => {
		const record = {
			...sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount - 10_000n })),
			erc20Balances: false,
		};

		const verdict = await validatorAt(fakeNode(), fakeOrderbook(record)).validate(
			submittedProposal(),
		);
		expect(verdict).toEqual({ kind: "reject", reason: "UnsupportedOrder" });
	});

	it("simulation transport error defers judgment", async () => {
		const node = fakeNode({
			estimateGas: async () => {
				throw new Error("connection refused");
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("rpc error code 3 marks the simulation failed", async () => {
		const node = fakeNode({
			estimateGas: async () => {
				throw { code: 3, message: "execution reverted" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "simFailed" });
	});

	it("rate limit error defers rather than failing the simulation", async () => {
		const node = fakeNode({
			estimateGas: async () => {
				throw { code: 429, message: "rate limit exceeded" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("trampoline is resolved once then served from the cache", async () => {
		const node = fakeNode();
		const record = sampleRecord(
			sampleOrder({ buyAmount: submittedProposal().maxBuyAmount - 10_000n }),
		);
		const validator = validatorAt(node, fakeOrderbook(record));
		const proposal = { ...submittedProposal(), trampoline: null };

		await validator.validate(proposal);
		await validator.validate(proposal);

		expect(node.counts.addressOf).toBe(1);
	});

	it("trampoline transport error defers judgment", async () => {
		const node = fakeNode({
			addressOf: async () => {
				throw new Error("connection refused");
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));
		const proposal = { ...submittedProposal(), trampoline: null };

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);
		expect(verdict).toBeNull();
	});

	it("trampoline revert marks the simulation failed", async () => {
		const node = fakeNode({
			addressOf: async () => {
				throw { code: 3, message: "execution reverted" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().maxBuyAmount }));
		const proposal = { ...submittedProposal(), trampoline: null };

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);
		expect(verdict).toEqual({ kind: "simFailed" });
	});
});
