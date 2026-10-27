import {
	type CowOrder,
	encodeSettle,
	OrderKind,
	OrderStatus,
	SigningScheme,
	TrampolineAbi,
} from "@byos/common";
import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	type PublicClient,
} from "viem";
import { afterEach, describe, expect, it } from "vitest";
import type { OrderRecord } from "../../../domain/order.js";
import type { Proposal } from "../../../domain/proposal.js";
import {
	_clearLocalAuctionState,
	_patchLocalGasPrice,
	_setLocalAuctionState,
} from "../../auction-state.js";
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
		status: OrderStatus.OPEN,
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
		simulationFailureParams: null,
		simulationBuyAmount: null,
		createdAt: new Date(0),
		statusChangedAt: new Date(0),
		sellTokenRefPrice: null,
		buyTokenRefPrice: null,
		surplusTokenRefPrice: null,
		auctionGasPrice: null,
		clearingPrices: null,
		auctionId: null,
	};
}

/**
 * Populates the in-memory auction state used by SimulationValidator.
 * By default prices all tokens at 1:1 (ETHER). Pass `prices` to override.
 */
function setupAuctionState(record: OrderRecord, prices?: Map<string, bigint>): void {
	const proposal = submittedProposal();
	const defaultPrices = new Map([
		[proposal.sellToken.toLowerCase(), ETHER],
		[proposal.buyToken.toLowerCase(), ETHER],
	]);
	_setLocalAuctionState({
		auctionId: 1,
		orders: new Map([[proposal.orderUid.toLowerCase(), record]]),
		prices: prices ?? defaultPrices,
		gasPrice: 0n,
	});
}

afterEach(() => _clearLocalAuctionState());

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
	authenticator?: () => Promise<string>;
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
			if (args.functionName === "authenticator" && opts?.authenticator) return opts.authenticator();
			return AUTHENTICATOR;
		},
		multicall: async ({ contracts }: { contracts: unknown[] }) =>
			contracts.map(() => ({ status: "success", result: 10n ** 30n })),
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

/**
 * Creates a SimulationValidator with the given node.
 * maxSlippageBps/maxSlippageNative default to effectively unlimited so
 * existing tests are unaffected by the gap check.
 */
function validatorAt(
	node: FakeNode,
	gasPrice = 0n,
	minScore = 0n,
	maxSlippageBps = 10_000n, // 100% — effectively disabled
	maxSlippageNative = 10n ** 36n, // astronomically large — effectively disabled
	_minCollateral = 10n ** 16n,
): SimulationValidator {
	// Gas price lives in auction state. Patch the local state so tests that
	// pass a non-zero gasPrice still exercise the profitability gate.
	_patchLocalGasPrice(gasPrice);
	return new SimulationValidator(
		node.client,
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		minScore,
		maxSlippageBps,
		maxSlippageNative,
		0n, // collateralRatioBps = 0 → Gate 2 exposure is 0, always passes
		0n, // minCollateral = 0 → penaltyCap = 0
		async () => ({ proposals: [], bufferBalance: 0n }), // fetchInflightData: no siblings
	);
}

/** Convenience: sets up auction state for `record` then returns a validator with a given minScore. */
function validatorWith(record: OrderRecord, minScore: bigint): SimulationValidator {
	setupAuctionState(record);
	return validatorAt(fakeNode(), 0n, minScore);
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
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(proposal);
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
		const args = node.simulateCalls[0] as {
			method: string;
			params: [Record<string, unknown>, string];
		};
		expect(args.method).toBe("eth_simulateV1");
		expect(args.params[1]).toBe("latest");

		const blockStateCall = (
			args.params[0] as {
				blockStateCalls: Array<{
					calls: Array<{ from: string; to: string; data: string }>;
					stateOverrides: Record<string, { code?: string; stateDiff?: Record<string, string> }>;
				}>;
			}
		).blockStateCalls[0]!;

		// Verify call envelope
		const call = blockStateCall.calls[0]!;
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
		const overrides = blockStateCall.stateOverrides ?? {};
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
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(proposal);

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
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(proposal);

		expect(verdict).toEqual({ kind: "reject", reason: "SimulationMissingExecutedEvent" });
	});

	it("buy order gate prices the sell token", async () => {
		// A buy order around the same proposal: exact buy amount (the envelope
		// requirement), sell limit above the proposal's so the pair carries
		// surplus — in the sell token. Only the sell token is priced: if the
		// gate wrongly priced the buy token it would reject as NativePriceUnavailable.
		const proposal = submittedProposal();
		const order = sampleOrder({
			kind: OrderKind.BUY,
			buyAmount: proposal.quoteBuyAmount,
			sellAmount: proposal.sellAmount + 100_000n,
		});
		// Only sell token is priced — buy token intentionally absent.
		// Buy orders skip the slippage check so buy token price is never needed.
		const prices = new Map([[order.sellToken.toLowerCase(), ETHER]]);
		_setLocalAuctionState({
			auctionId: 1,
			orders: new Map([[proposal.orderUid.toLowerCase(), sampleRecord(order)]]),
			prices,
			gasPrice: 0n,
		});

		const verdict = await validatorAt(fakeNode()).validate(proposal);
		expect(verdict).toMatchObject({ kind: "accept" });
	});

	it("submitted proposal is rejected when unprofitable", async () => {
		// 1 gwei: the simulated 100k gas costs ~1.3e14 wei, dwarfing the
		// 10_000-wei surplus at parity pricing — the score is deeply negative.
		const gasPrice = 1_000_000_000n;
		const submitted = submittedProposal();
		const record = sampleRecord(sampleOrder({ buyAmount: submitted.quoteBuyAmount - 10_000n }));
		setupAuctionState(record);

		const first = await validatorAt(fakeNode(), gasPrice).validate(submitted);
		expect(first).toEqual({ kind: "reject", reason: "Unprofitable" });
	});

	it("missing native price rejects with NativePriceUnavailable", async () => {
		// For sell orders the buy token price is needed for the slippage check.
		// If it is absent the validator rejects — prices come from auction state
		// and are expected to be present for all included tokens.
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		const sellToken = submittedProposal().sellToken.toLowerCase();
		// buyToken intentionally absent from prices
		setupAuctionState(record, new Map([[sellToken, ETHER]]));

		const verdict = await validatorAt(fakeNode()).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "NativePriceUnavailable" });
	});

	it("unknown order rejects proposal", async () => {
		// Auction state exists but the order UID is not in it.
		_setLocalAuctionState({
			auctionId: 1,
			orders: new Map(), // empty — no matching UID
			prices: new Map([
				[submittedProposal().sellToken.toLowerCase(), ETHER],
				[submittedProposal().buyToken.toLowerCase(), ETHER],
			]),
			gasPrice: 0n,
		});

		const verdict = await validatorAt(fakeNode()).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "OrderNotFound" });
	});

	it("no active auction defers judgment", async () => {
		// When there is no auction state the validator defers so the proposal
		// can be cleaned up by abandonAuctionProposals once the window closes.
		_clearLocalAuctionState();

		const verdict = await validatorAt(fakeNode()).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("out of envelope order rejects proposal", async () => {
		const record = {
			...sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount - 10_000n })),
			erc20Balances: false,
		};
		setupAuctionState(record);

		const verdict = await validatorAt(fakeNode()).validate(submittedProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "UnsupportedOrder" });
	});

	it("simulation transport error defers judgment", async () => {
		const node = fakeNode({
			simulateV1: async () => {
				throw new Error("connection refused");
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("simulation revert (status 0x0) marks the simulation failed", async () => {
		const node = fakeNode({
			simulateV1: async () => simulateRevert(),
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(submittedProposal());
		expect(verdict).toMatchObject({ kind: "simFailed" });
	});

	it("rate limit error defers rather than failing the simulation", async () => {
		const node = fakeNode({
			simulateV1: async () => {
				throw { code: 429, message: "rate limit exceeded" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		setupAuctionState(record);

		const verdict = await validatorAt(node).validate(submittedProposal());
		expect(verdict).toBeNull();
	});

	it("trampoline is resolved once then served from the cache", async () => {
		const node = fakeNode();
		const record = sampleRecord(
			sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount - 10_000n }),
		);
		setupAuctionState(record);
		const validator = validatorAt(node);
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
		setupAuctionState(record);
		const proposal = { ...submittedProposal(), trampoline: null };

		const verdict = await validatorAt(node).validate(proposal);
		expect(verdict).toBeNull();
	});

	it("trampoline revert marks the simulation failed", async () => {
		const node = fakeNode({
			addressOf: async () => {
				throw { code: 3, message: "execution reverted" };
			},
		});
		const record = sampleRecord(sampleOrder({ buyAmount: submittedProposal().quoteBuyAmount }));
		setupAuctionState(record);
		const proposal = { ...submittedProposal(), trampoline: null };

		const verdict = await validatorAt(node).validate(proposal);
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
		setupAuctionState(record);

		const verdict = await validatorAt(
			node,
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
		setupAuctionState(record);

		const verdict = await validatorAt(
			node,
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
		setupAuctionState(record);

		const verdict = await validatorAt(
			node,
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
		setupAuctionState(record);

		const verdict = await validatorAt(
			node,
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
		// Only sell token is priced — buy orders don't need buy token price for slippage.
		_setLocalAuctionState({
			auctionId: 1,
			orders: new Map([[proposal.orderUid.toLowerCase(), buyOrder]]),
			prices: new Map([[buyOrder.order.sellToken.toLowerCase(), ETHER]]),
			gasPrice: 0n,
		});

		const verdict = await validatorAt(
			node,
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

function collateralValidator(
	options: {
		balance?: bigint;
		bufferBalance?: bigint;
		gasPrice?: bigint;
		gasUsed?: bigint;
		siblings?: Awaited<ReturnType<import("../validator.js").FetchInflightData>>["proposals"];
		fetchInflight?: import("../validator.js").FetchInflightData;
	} = {},
) {
	// buyAmount: 0n → order limit is zero, so any positive proposalBuy gives surplus.
	// This prevents the profitability gate from interfering with collateral tests whose
	// purpose is to exercise the exposure math, not scoring.
	setupAuctionState(sampleRecord(sampleOrder({ buyAmount: 0n })));
	// Gas price lives in auction state — patch it if a specific value is needed.
	if (options.gasPrice !== undefined) _patchLocalGasPrice(options.gasPrice);
	const node = fakeNode({
		simulateV1: async () =>
			simulateSuccess(
				990_000n,
				submittedProposal().orderUidHash as Hex,
				options.gasUsed ?? 100_000n,
			),
	});
	const client = {
		...node.client,
		multicall: async ({ contracts }: { contracts: unknown[] }) =>
			contracts.map(() => ({ status: "success", result: options.balance ?? ETHER })),
	} as unknown as PublicClient;
	// Use a very negative minScore to disable the profitability gate for
	// collateral tests — they exercise exposure logic, not scoring.
	return new SimulationValidator(
		client,
		SETTLEMENT,
		ESCROW,
		TRAMPOLINE_FACTORY,
		-(10n ** 30n),
		10_000n,
		ETHER,
		4n,
		ETHER / 100n,
		options.fetchInflight ??
			(async () => ({
				proposals: options.siblings ?? [],
				bufferBalance: options.bufferBalance ?? 0n,
			})),
	);
}

function activeProposal(): Proposal {
	return { ...submittedProposal(), gasUsed: 100_000n };
}

describe("collateral admission", () => {
	it("reserves the absolute cap for a legacy unpriced sibling without rejecting it as unavailable", async () => {
		const validator = collateralValidator({
			siblings: [{ id: 2, gasUsed: null, sellAmountNative: null }],
		});
		expect((await validator.validate(activeProposal()))?.kind).toBe("accept");
	});

	it("accepts when the sibling list is empty and balance covers the single proposal", async () => {
		// With no siblings, the only exposure is the current proposal (400 wei).
		// A balance of exactly 400 wei is sufficient.
		const validator = collateralValidator({
			balance: 400n,
			siblings: [],
		});
		expect((await validator.validate(activeProposal()))?.kind).toBe("accept");
	});

	it("deliberately allows concurrent admissions to share the same collateral snapshot", async () => {
		let readers = 0;
		let release: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const validator = collateralValidator({
			balance: 500n,
			fetchInflight: async () => {
				readers++;
				if (readers === 2) release();
				await ready;
				return { proposals: [], bufferBalance: 0n };
			},
		});
		const verdicts = await Promise.all([
			validator.validate(activeProposal()),
			validator.validate({ ...activeProposal(), id: 2 }),
		]);
		expect(verdicts.map((v) => v?.kind)).toEqual(["accept", "accept"]);
		// Each proposal reserves 400 wei; their combined 800 wei exceeds 500 wei.
	});
});

describe("buffer debt and collateral", () => {
	it.each([
		{ bufferBalance: -1_000_000n, balance: 399n, kind: "reject" },
		{ bufferBalance: 0n, balance: 400n, kind: "accept" },
		{ bufferBalance: 1n, balance: 400n, kind: "reject" },
	])(
		"checks $balance wei against signed buffer $bufferBalance",
		async ({ bufferBalance, balance, kind }) => {
			expect(
				(await collateralValidator({ bufferBalance, balance }).validate(activeProposal()))?.kind,
			).toBe(kind);
		},
	);
});

describe("post-simulation collateral", () => {
	it("rejects high-gas routes that fit only the old 200k estimate", async () => {
		const verdict = await collateralValidator({
			balance: 300_400n,
			gasPrice: 1n,
			gasUsed: 1_000_000n,
		}).validate(activeProposal());
		expect(verdict).toEqual({ kind: "reject", reason: "ExposureCapExceeded" });
	});
	it("defers on a failed collateral snapshot", async () => {
		const verdict = await collateralValidator({
			fetchInflight: async () => {
				throw new Error("DB unavailable");
			},
		}).validate(activeProposal());
		expect(verdict).toBeNull();
	});
});

describe("collateral exposure equality boundary", () => {
	it.each([
		{ balance: 100_399n, kind: "reject" },
		{ balance: 100_400n, kind: "accept" },
		{ balance: 100_401n, kind: "accept" },
	])("admits $balance wei with a 100400 wei exposure: $kind", async ({ balance, kind }) => {
		expect(
			(
				await collateralValidator({ balance, gasPrice: 1n, gasUsed: 100_000n }).validate(
					activeProposal(),
				)
			)?.kind,
		).toBe(kind);
	});
});

describe("concurrent simulation metadata reads", () => {
	it("starts authenticator lookup before trampoline resolution completes", async () => {
		let release: (address: string) => void = () => {};
		const trampoline = new Promise<string>((resolve) => {
			release = resolve;
		});
		const node = fakeNode({
			addressOf: () => trampoline,
			authenticator: async () => {
				release(TRAMPOLINE);
				return AUTHENTICATOR;
			},
		});
		// Use buyAmount well below quoteBuyAmount to ensure positive surplus.
		setupAuctionState(sampleRecord(sampleOrder({ buyAmount: 800_000n })));
		const validator = validatorAt(node);
		expect((await validator.validate({ ...activeProposal(), trampoline: null }))?.kind).toBe(
			"accept",
		);
	});
	it("defers when authenticator lookup fails", async () => {
		const node = fakeNode({
			authenticator: async () => {
				throw new Error("RPC unavailable");
			},
		});
		// Use buyAmount well below quoteBuyAmount to ensure positive surplus.
		setupAuctionState(sampleRecord(sampleOrder({ buyAmount: 800_000n })));
		const validator = validatorAt(node);
		expect(await validator.validate(activeProposal())).toBeNull();
	});
});
