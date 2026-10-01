import { type CowOrder, encodeSettle, OrderKind, SigningScheme, TrampolineAbi } from "@byos/common";
import {
	encodeAbiParameters,
	encodeEventTopics,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
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
const TRAMPOLINE = "0x4444444444444444444444444444444444441234";
const ETHER = 10n ** 18n;

// ── Simulated-log helpers ────────────────────────────────────────────────────

/** Matches SimulateV1CallResult in validator.ts. */
interface SimulateV1Log {
	address: Hex;
	topics: [Hex, ...Hex[]];
	data: Hex;
}

interface SimulateV1CallResult {
	returnData: Hex;
	logs: SimulateV1Log[];
	gasUsed: Hex;
	status: Hex;
	error?: { message: string; code: number; data: Hex };
}

/** Encodes a Trampoline Executed event log for the given trampoline and delta. */
function buildExecutedLog(trampoline: Address, orderUidHash: Hex, delta: bigint): SimulateV1Log {
	const topics = encodeEventTopics({
		abi: TrampolineAbi,
		eventName: "Executed",
		args: { _orderUidHash: orderUidHash },
	}) as [Hex, Hex];

	const data = encodeAbiParameters(
		[{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
		[delta, 0n, 0n],
	);

	return { address: trampoline as Hex, topics, data };
}

/** Builds a successful simulateV1 call result with a single Executed log. */
function simulateSuccess(
	delta: bigint,
	orderUidHash: Hex,
	gasUsed = 100_000n,
): SimulateV1CallResult {
	return {
		status: "0x1",
		gasUsed: `0x${gasUsed.toString(16)}`,
		returnData: "0x",
		logs: [buildExecutedLog(TRAMPOLINE, orderUidHash, delta)],
	};
}

/** Builds a failed simulateV1 call result (revert). */
function simulateRevert(returnData: Hex = "0x"): SimulateV1CallResult {
	return {
		status: "0x0",
		gasUsed: "0x0",
		returnData,
		logs: [],
	};
}

// ── Test fixtures ────────────────────────────────────────────────────────────

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
		quoteBuyAmount: 990_000n,
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
		trampoline: TRAMPOLINE,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
		simulationFailureParams: null,
		simulationBuyAmount: null,
		createdAt: new Date(0),
		statusChangedAt: new Date(0),
		sellTokenRefPrice: null,
		surplusTokenRefPrice: null,
		auctionGasPrice: null,
		clearingPrices: null,
	};
}

// ── Fake RPC node ────────────────────────────────────────────────────────────

interface FakeNode {
	client: PublicClient;
	counts: { addressOf: number; simulateV1: number };
	simulateCalls: Array<unknown>;
}

/**
 * Fake RPC node for eth_simulateV1-based validation.
 * By default returns a successful simulation with a fixed Executed log
 * (delta = quoteBuyAmount of submittedProposal). Override `simulateV1` to
 * inject custom results or errors.
 */
function fakeNode(opts?: {
	simulateV1?: () => Promise<SimulateV1CallResult>;
	addressOf?: () => Promise<string>;
	/** Default Executed._delta (defaults to submittedProposal().quoteBuyAmount). */
	delta?: bigint;
}): FakeNode {
	const counts = { addressOf: 0, simulateV1: 0 };
	const simulateCalls: Array<unknown> = [];
	const defaultDelta = opts?.delta ?? submittedProposal().quoteBuyAmount;

	const client = {
		readContract: async (args: { functionName: string }) => {
			if (args.functionName === "addressOf") {
				counts.addressOf += 1;
				return opts?.addressOf ? await opts.addressOf() : TRAMPOLINE;
			}
			// authenticator() or other view calls
			return AUTHENTICATOR;
		},
		getBlockNumber: async () => 1_000n,
		request: async (args: unknown) => {
			const typed = args as { method: string; params: unknown[] };
			if (typed.method === "eth_simulateV1") {
				counts.simulateV1 += 1;
				simulateCalls.push(args);
				const result = opts?.simulateV1
					? await opts.simulateV1()
					: simulateSuccess(defaultDelta, submittedProposal().orderUidHash as Hex);
				return [{ calls: [result] }];
			}
			throw new Error(`unexpected RPC method: ${typed.method}`);
		},
	} as unknown as PublicClient;

	return { client, counts, simulateCalls };
}

// ── Validator factories ──────────────────────────────────────────────────────

function fakeOrderbook(record: OrderRecord): FetchOrder {
	return {
		order: async () => record,
		nativePrice: async () => ETHER, // 1:1 — surplus in atoms equals surplus in wei
	};
}

/**
 * Creates a SimulationValidator with the given node and orderbook.
 * maxSlippageBps/maxSlippageNative default to effectively unlimited so
 * existing tests are unaffected by the gap check.
 */
function validatorAt(
	node: FakeNode,
	orderbook: FetchOrder,
	gasPrice = 0n,
	minScore = 0n,
	maxSlippageBps = 10_000n, // 100% — effectively disabled
	maxSlippageNative = 10n ** 36n, // astronomically large — effectively disabled
): SimulationValidator {
	return new SimulationValidator(
		node.client,
		orderbook,
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		{ value: gasPrice },
		minScore,
		maxSlippageBps,
		maxSlippageNative,
	);
}

/** Convenience: validator for a fixed orderbook record with a given minScore. */
function validatorWith(record: OrderRecord, minScore: bigint): SimulationValidator {
	return validatorAt(fakeNode(), fakeOrderbook(record), 0n, minScore);
}

// ── Profitability gate ───────────────────────────────────────────────────────

describe("SimulationValidator profitability gate", () => {
	it("zero-surplus first simulation rejects as unprofitable", async () => {
		// Order limit equal to the proposal's buy amount: zero surplus. With a
		// zero gas price the score is exactly 0, which must NOT exceed the
		// default minScore of 0 — score must be strictly greater.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score exactly at a nonzero minScore rejects", async () => {
		// Surplus of 10_000 atoms priced 1:1 scores exactly 10_000.
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount - 10_000n }));

		const verdict = await validatorWith(record, 10_000n).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("score above minScore accepts", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount - 10_000n }));

		const verdict = await validatorWith(record, 0n).validate(proposal);

		expect(verdict).toMatchObject({ kind: "accept" });
	});
});

// ── eth_simulateV1 dispatch ──────────────────────────────────────────────────

describe("SimulationValidator", () => {
	it("simulation dispatches full settle calldata via eth_simulateV1", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount - 10_000n }));
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

		expect(node.simulateCalls).toHaveLength(1);
		const args = node.simulateCalls[0] as { method: string; params: [Record<string, unknown>, string] };
		expect(args.method).toBe("eth_simulateV1");
		expect(args.params[1]).toBe("latest");

		const blockStateCall = (args.params[0] as { blockStateCalls: Array<{
			calls: Array<{ from: string; to: string; data: string }>;
			stateOverrides: Record<string, { code?: string; stateDiff?: Record<string, string> }>;
		}> }).blockStateCalls[0];

		// Verify call envelope
		const call = blockStateCall.calls[0];
		expect(call.from).toBe(DUMMY_SUBMITTER);
		expect(call.to).toBe(SETTLEMENT);
		expect(call.data).toBe(
			encodeSettle(
				record.order,
				{
					orderUidHash: proposal.orderUidHash,
					sellToken: proposal.sellToken,
					buyToken: proposal.buyToken,
					sellAmount: proposal.sellAmount,
					minBuyAmount: proposal.minBuyAmount,
					quoteBuyAmount: proposal.quoteBuyAmount,
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

		// Verify state overrides: AnyoneAuthenticator at authenticator, SUBMITTER_ROLE at escrow
		const overrides = blockStateCall.stateOverrides;
		expect(overrides[AUTHENTICATOR]?.code).toMatch(/^0x6080/);
		const escrowStateDiff = overrides[ESCROW]?.stateDiff ?? {};
		const slots = Object.keys(escrowStateDiff);
		expect(slots).toHaveLength(1);
		expect(escrowStateDiff[slots[0] as Hex]).toMatch(/0*1$/);
	});

	it("accept verdict includes simulationBuyAmount from Executed event", async () => {
		const proposal = submittedProposal();
		const delta = proposal.quoteBuyAmount + 5_000n; // delta > quote → effectiveBuyAmount = quote
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount - 10_000n }));
		const node = fakeNode({ delta });

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);

		expect(verdict).toMatchObject({
			kind: "accept",
			simulation: { simulationBuyAmount: delta },
		});
	});

	it("missing Executed event rejects with SimulationMissingExecutedEvent", async () => {
		const proposal = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: proposal.quoteBuyAmount - 10_000n }));
		const node = fakeNode({
			simulateV1: async () => ({
				status: "0x1",
				gasUsed: "0x186a0",
				returnData: "0x",
				logs: [], // no Executed event
			}),
		});

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "SimulationMissingExecutedEvent" });
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
			buyAmount: proposal.quoteBuyAmount,
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
		const record = sampleRecord(sampleOrder({ buyAmount: submitted.quoteBuyAmount - 10_000n }));

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
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
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
			...sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount - 10_000n })),
			erc20Balances: false,
		};

		const verdict = await validatorAt(fakeNode(), fakeOrderbook(record)).validate(
			submittedProposal(),
		);
		expect(verdict).toEqual({ kind: "reject", reason: "UnsupportedOrder" });
	});

	it("simulation transport error defers judgment", async () => {
		const node = fakeNode({
			simulateV1: async () => {
				throw new Error("connection refused");
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("simulation revert (status 0x0) marks the simulation failed", async () => {
		const node = fakeNode({
			simulateV1: async () => simulateRevert(),
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toMatchObject({ kind: "simFailed" });
	});

	it("rate limit error defers rather than failing the simulation", async () => {
		const node = fakeNode({
			simulateV1: async () => {
				throw { code: 429, message: "rate limit exceeded" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("trampoline is resolved once then served from the cache", async () => {
		const node = fakeNode();
		const record = sampleRecord(
			sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount - 10_000n }),
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
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
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
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		const proposal = { ...submittedProposal(), trampoline: null };

		const verdict = await validatorAt(node, fakeOrderbook(record)).validate(proposal);
		expect(verdict).toEqual({ kind: "simFailed" });
	});
});

// ── Gap check (checkProposalSlippage integration) ────────────────────────────

describe("SimulationValidator gap check", () => {
	/** Proposal with a gap between minBuyAmount and quoteBuyAmount. */
	function gappedProposal(minBuyAmount: bigint, quoteBuyAmount: bigint): Proposal {
		return { ...submittedProposal(), minBuyAmount, quoteBuyAmount };
	}

	function orderFor(quoteBuyAmount: bigint): OrderRecord {
		// order.buyAmount = minBuyAmount (order limit) ≤ minBuyAmount in the proposal
		return sampleRecord(sampleOrder({ buyAmount: quoteBuyAmount - 10_000n }));
	}

	it("rejects when bps cap is exceeded", async () => {
		// gap = 10_000, quoteBuyAmount = 990_000 → 10_000/990_000 ≈ 101 bps
		// max = 100 bps → reject
		const proposal = gappedProposal(980_000n, 990_000n);
		const record = orderFor(proposal.quoteBuyAmount);
		const node = fakeNode({ delta: proposal.quoteBuyAmount });

		const verdict = await validatorAt(
			node,
			fakeOrderbook(record),
			0n,
			0n,
			100n, // 1% cap
			10n ** 36n,
		).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "ProposedSlippageOutrange" });
	});

	it("accepts when gap is exactly at the bps cap", async () => {
		// gap = 9_900, quoteBuyAmount = 990_000 → 9_900/990_000 = 100 bps exactly
		// 9_900 * 10_000 = 99_000_000 vs 990_000 * 100 = 99_000_000 → NOT strictly greater → pass
		const proposal = gappedProposal(980_100n, 990_000n);
		const record = orderFor(proposal.quoteBuyAmount);
		const node = fakeNode({ delta: proposal.quoteBuyAmount });

		const verdict = await validatorAt(
			node,
			fakeOrderbook(record),
			0n,
			0n,
			100n, // 1% cap
			10n ** 36n,
		).validate(proposal);

		expect(verdict).toMatchObject({ kind: "accept" });
	});

	it("rejects when native cap is exceeded", async () => {
		// gap = 10_000, nativePrice = 1 ETHER (1:1), maxNative = 5_000 wei
		// gap * ETHER > 5_000 * ETHER → reject
		const proposal = gappedProposal(980_000n, 990_000n);
		const record = orderFor(proposal.quoteBuyAmount);
		const node = fakeNode({ delta: proposal.quoteBuyAmount });

		const verdict = await validatorAt(
			node,
			fakeOrderbook(record),
			0n,
			0n,
			10_000n, // bps cap large enough to not trigger
			5_000n, // 5_000 wei native cap — gap of 10_000 atoms * 1 ETHER/atom > 5_000 * ETHER
		).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "ProposedSlippageOutrange" });
	});

	it("passes when gap is zero", async () => {
		// min == quote → no gap → always accepted regardless of limits
		const proposal = gappedProposal(990_000n, 990_000n);
		const record = orderFor(proposal.quoteBuyAmount);
		const node = fakeNode({ delta: proposal.quoteBuyAmount });

		const verdict = await validatorAt(
			node,
			fakeOrderbook(record),
			0n,
			0n,
			0n, // zero cap — would reject any positive gap
			0n,
		).validate(proposal);

		expect(verdict).toMatchObject({ kind: "accept" });
	});

	it("buy orders skip the gap check regardless of min/quote spread", async () => {
		// Buy orders enforce minBuyAmount == quoteBuyAmount in checkEnvelope;
		// checkProposalSlippage returns null for BUY orders unconditionally.
		const buyOrder = sampleRecord(
			sampleOrder({
				kind: OrderKind.BUY,
				buyAmount: 990_000n,
				sellAmount: 1_100_000n, // sell limit above proposal — carries sell surplus
			}),
		);
		const proposal = submittedProposal(); // minBuyAmount == quoteBuyAmount == 990_000
		const node = fakeNode({ delta: proposal.quoteBuyAmount });

		const verdict = await validatorAt(
			node,
			{ order: async () => buyOrder, nativePrice: async () => ETHER },
			0n,
			0n,
			0n, // zero cap
			0n,
		).validate(proposal);

		// Should not reject for slippage; may accept or defer depending on scoring
		expect(verdict?.kind).not.toBe("reject");
		// (in practice this accepts — sell surplus with zero gas cost)
	});
});
