import { OrderKind, TrampolineAbi, TrampolineFactoryAbi } from "@byos/common";
import type { Logger } from "pino";
import type { Address, Hex, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { availableCollateral, penaltyCap, perProposalCL } from "../../domain/collateral.js";
import { checkEnvelope, checkProposalSlippage } from "../../domain/order.js";
import { effectiveBuyAmount, type Proposal } from "../../domain/proposal.js";
import {
	type Candidate,
	ESCROW_GAS_ESTIMATION,
	effectiveGas,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import type { SimulationFailureParams, ValidateProposal, Verdict } from "../../domain/validator.js";
import { getAuctionState } from "../auction-state.js";
import { createBatchedEscrowBalanceReader, type EscrowValidator } from "./escrow.js";
import { buildSimulation } from "./simulation.js";

/**
 * Per-subsolver in-flight data needed for Gate 2 cumulative exposure check.
 * Returns only `submitted` proposals already sent to the driver (in DB).
 * The candidate being validated is not yet in the DB; its exposure is added
 * by the validator itself after fetching this data.
 * `bufferBalance` is the sum of uncleared buffer_entries.nativeTokenAmount for
 * the subsolver, subtracted from effectiveBalance to get the adjusted balance.
 */
export type FetchInflightData = (
	subSolver: Address,
) => Promise<{
	proposals: { id: number; gasUsed: bigint | null; sellAmountNative: bigint | null }[];
	bufferBalance: bigint;
}>;

function buildTenderlyUrl({
	chainId,
	blockNumber,
	from,
	to,
	calldata,
}: {
	chainId: number;
	blockNumber: bigint;
	from: string;
	to: string;
	calldata: string;
}): string {
	try {
		const params = new URLSearchParams({
			block: blockNumber.toString(),
			blockIndex: "0",
			from,
			gas: "8000000",
			gasPrice: "0",
			value: "0",
			contractAddress: to,
			network: chainId.toString(),
			rawFunctionInput: calldata,
		});
		return `https://dashboard.tenderly.co/simulator/new?${params.toString()}`;
	} catch {
		return "";
	}
}

/** ABI for the settlement contract's authenticator() view function. */
const settlementAuthenticatorAbi = [
	{
		type: "function",
		name: "authenticator",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
] as const;

/** eth_simulateV1 call result shape returned by dRPC / Geth nodes. */
interface SimulateV1CallResult {
	returnData: Hex;
	logs: {
		address: Hex;
		topics: [Hex, ...Hex[]];
		data: Hex;
	}[];
	gasUsed: Hex;
	status: Hex;
	error?: { message: string; code: number; data: Hex };
}

/**
 * Converts SimulationStateOverride[] to the stateOverrides map format required
 * by eth_simulateV1's blockStateCalls entry: { [address]: { code?, stateDiff? } }.
 */
function toSimulateV1StateOverrides(
	overrides: ReturnType<typeof buildSimulation>["stateOverride"],
): Record<string, { code?: Hex; stateDiff?: Record<Hex, Hex> }> {
	const result: Record<string, { code?: Hex; stateDiff?: Record<Hex, Hex> }> = {};
	for (const { address, code, stateDiff } of overrides) {
		result[address] = { ...(code ? { code } : {}), ...(stateDiff ? { stateDiff } : {}) };
	}
	return result;
}

/**
 * Extracts a human-readable revert reason from raw revert bytes.
 * Handles Error(string) — selector 0x08c379a0.
 */
function extractRevertReasonFromHex(data: Hex | undefined): string | null {
	if (!data || data === "0x") return null;
	if (!data.startsWith("0x08c379a0")) return null;
	try {
		const hex = data.slice(10);
		const buf = Buffer.from(hex, "hex");
		const len = Number(BigInt(`0x${buf.slice(32, 64).toString("hex")}`));
		return buf.slice(64, 64 + len).toString("utf8");
	} catch {
		return null;
	}
}

/**
 * Reads revert data from a simulateV1 call result.
 * Most chains (Geth, OP-stack) put the ABI-encoded revert payload in error.data;
 * BNB puts it in returnData. Check error.data first, fall back to returnData.
 */
function revertDataFrom(call: SimulateV1CallResult): Hex | undefined {
	if (call.error?.data && call.error.data !== "0x") return call.error.data;
	if (call.returnData && call.returnData !== "0x") return call.returnData;
	return undefined;
}

/**
 * Finds the trampoline's Executed event in simulation logs and returns _delta.
 * Returns null if the event is not found.
 */
function parseExecutedDelta(
	logs: SimulateV1CallResult["logs"],
	trampoline: Address,
): bigint | null {
	for (const log of logs) {
		if (log.address.toLowerCase() !== trampoline.toLowerCase()) continue;
		try {
			const decoded = decodeEventLog({
				abi: TrampolineAbi,
				eventName: "Executed",
				topics: log.topics,
				data: log.data,
			});
			return (decoded.args as { _delta: bigint })._delta;
		} catch {
			// not the Executed event — continue
		}
	}
	return null;
}

export class SimulationValidator implements ValidateProposal {
	private trampolineCache = new Map<string, Address>();
	private authenticator: Address | null = null;

	constructor(
		private readonly publicClient: PublicClient,
		private readonly settlementAddress: Address,
		private readonly escrowAddress: Address,
		private readonly trampolineFactory: Address,
		private readonly minScore: bigint,
		private readonly maxSlippageBps: bigint,
		private readonly maxSlippageNative: bigint,
		private readonly collateralRatioBps: bigint,
		private readonly minCollateral: bigint,
		private readonly fetchInflightData: FetchInflightData,
		private readonly logger?: Logger,
		private readonly submitter?: Address,
		private readonly readEscrowBalance: (
			subSolver: Address,
		) => Promise<bigint> = createBatchedEscrowBalanceReader(publicClient, escrowAddress),
	) {}

	private async resolveTrampoline(subSolver: Address): Promise<Address> {
		const key = subSolver.toLowerCase();
		const cached = this.trampolineCache.get(key);
		if (cached) return cached;

		const trampoline = await this.publicClient.readContract({
			address: this.trampolineFactory,
			abi: TrampolineFactoryAbi,
			functionName: "addressOf",
			args: [subSolver],
		});

		this.trampolineCache.set(key, trampoline);
		return trampoline;
	}

	private async resolveAuthenticator(): Promise<Address> {
		if (this.authenticator) return this.authenticator;

		const addr = await this.publicClient.readContract({
			address: this.settlementAddress,
			abi: settlementAuthenticatorAbi,
			functionName: "authenticator",
		});

		this.authenticator = addr;
		return addr;
	}

	private profitability(
		proposal: Proposal,
		record: import("../../domain/order.js").OrderRecord,
		gas: bigint,
		surplusPrice: bigint,
		gasPrice: bigint,
	): "ok" | "unprofitable" {
		const isSellOrder = record.order.kind === OrderKind.SELL;
		const gasCost = effectiveGas(gas) * gasPrice;

		const candidate: Candidate = {
			orderSell: record.order.sellAmount,
			orderBuy: record.order.buyAmount,
			proposalSell: proposal.sellAmount,
			proposalBuy: effectiveBuyAmount(proposal),
			isSellOrder,
			gasCost,
		};

		const scaled = scaledToFill(candidate, record.order.partiallyFillable);
		if (!scaled) return "unprofitable";

		// Score must strictly exceed minScore: a breakeven proposal (gas equal
		// to surplus, score 0) is rejected at the default minScore of 0.
		const score = scoreProposal(scaled, surplusPrice);
		if (score === null || score <= this.minScore) return "unprofitable";

		return "ok";
	}

	async validate(proposal: Proposal): Promise<Verdict | null> {
		// Settle all independent reads immediately so early returns cannot leave
		// unhandled rejections. Simulation can proceed while these reads finish.
		const collateralReads = Promise.allSettled([
			this.fetchInflightData(proposal.subSolver),
			this.readEscrowBalance(proposal.subSolver),
		]);

		// Order data, prices, and gas price come from the auction state populated
		// by /solve. If absent the auction already closed — defer.
		const auctionState = await getAuctionState();
		if (!auctionState) return null;

		const gasPrice = auctionState.gasPrice;

		const record = auctionState.orders.get(proposal.orderUid.toLowerCase());
		if (!record) {
			return { kind: "reject", reason: "OrderNotFound" };
		}

		const sellTokenRefPrice = auctionState.prices.get(proposal.sellToken.toLowerCase());
		if (!sellTokenRefPrice || sellTokenRefPrice <= 0n) {
			return { kind: "reject", reason: "NativePriceUnavailable" };
		}

		// Slippage gap check uses buy token price for sell orders. Buy orders skip
		// the check entirely so 0n is a safe sentinel.
		let nativePrice = 0n;
		if (record.order.kind === OrderKind.SELL) {
			const p = auctionState.prices.get(proposal.buyToken.toLowerCase());
			if (!p) return { kind: "reject", reason: "NativePriceUnavailable" };
			nativePrice = p;
		}

		// Surplus token price for profitability gate.
		const surplusTkn = surplusToken(
			record.order.kind === OrderKind.SELL,
			record.order.sellToken,
			record.order.buyToken,
		);
		const surplusPrice = auctionState.prices.get(surplusTkn.toLowerCase());
		if (!surplusPrice) return { kind: "reject", reason: "NativePriceUnavailable" };

		// Step 2: Check envelope validity
		const envelopeReason = checkEnvelope(record, proposal);
		if (envelopeReason) {
			return { kind: "reject", reason: envelopeReason };
		}

		// Step 3: Gap check — reject if min/quote spread exceeds configured limits
		const slippageReason = checkProposalSlippage(
			record,
			proposal,
			nativePrice,
			this.maxSlippageBps,
			this.maxSlippageNative,
		);
		if (slippageReason) {
			return { kind: "reject", reason: slippageReason };
		}

		// Independent metadata reads start together so the shared viem client's
		// Multicall3 batch can combine them on a cold cache. Keep failure
		// classification per call: a trampoline revert is terminal, RPC errors defer.
		const [trampolineResult, authenticatorResult] = await Promise.allSettled([
			proposal.trampoline
				? Promise.resolve(proposal.trampoline)
				: this.resolveTrampoline(proposal.subSolver),
			this.resolveAuthenticator(),
		]);
		if (trampolineResult.status === "rejected") {
			const error: unknown = trampolineResult.reason;
			if (isRevertError(error))
				return {
					kind: "simFailed",
					revertReason: extractRevertReasonFromThrown(error) ?? undefined,
				};
			return null;
		}
		if (authenticatorResult.status === "rejected") return null;
		const trampoline = trampolineResult.value;
		const authenticator = authenticatorResult.value;

		// Step 6: Build simulation
		const sim = buildSimulation({
			settlement: this.settlementAddress,
			authenticator,
			escrow: this.escrowAddress,
			trampoline,
			order: record.order,
			proposal: {
				orderUidHash: proposal.orderUidHash,
				sellToken: proposal.sellToken,
				buyToken: proposal.buyToken,
				sellAmount: proposal.sellAmount,
				minBuyAmount: proposal.minBuyAmount,
				quoteBuyAmount: proposal.quoteBuyAmount,
				validUntil: proposal.validUntil,
				nonce: proposal.nonce,
			},
			route: proposal.interactions,
			signature: proposal.signature,
			preInteractions: record.preInteractions,
			postInteractions: record.postInteractions,
			submitter: this.submitter,
		});

		// Step 7: Dispatch eth_simulateV1
		let result: unknown;
		const simulationStarted = performance.now();
		try {
			result = await this.publicClient.request({
				method: "eth_simulateV1" as never,
				params: [
					{
						blockStateCalls: [
							{
								calls: [
									{
										from: sim.submitter,
										to: this.settlementAddress,
										data: sim.calldata,
									},
								],
								...(sim.stateOverride.length > 0
									? { stateOverrides: toSimulateV1StateOverrides(sim.stateOverride) }
									: {}),
							},
						],
					},
					"latest",
				] as never,
			});
		} catch {
			return null; // transport error, defer
		}
		this.logger?.debug(
			{ proposalId: proposal.id, elapsedMs: performance.now() - simulationStarted },
			"validation simulation RPC finished",
		);

		const firstBlock = Array.isArray(result)
			? (result as { calls?: SimulateV1CallResult[] }[])[0]
			: undefined;
		if (!firstBlock || !Array.isArray(firstBlock.calls) || !firstBlock.calls[0]) {
			this.logger?.error({ proposalId: proposal.id }, "eth_simulateV1 unexpected response shape");
			return null;
		}
		const call = firstBlock.calls[0];

		// Step 8: Handle revert
		if (call.status === "0x0") {
			const revertData = revertDataFrom(call);
			const revertReason =
				extractRevertReasonFromHex(revertData) ?? call.error?.message ?? "execution reverted";

			const chainId = this.publicClient.chain?.id;
			let blockNumber: bigint | undefined;
			try {
				blockNumber = await this.publicClient.getBlockNumber();
			} catch {
				// best-effort
			}
			const simulationFailureParams: SimulationFailureParams | undefined =
				chainId && blockNumber !== undefined
					? {
							chainId,
							blockNumber: blockNumber.toString(),
							timestamp: Math.floor(Date.now() / 1000),
							from: sim.submitter,
							to: this.settlementAddress,
							calldata: sim.calldata,
						}
					: undefined;

			if (this.logger) {
				const tenderlyUrl = simulationFailureParams
					? buildTenderlyUrl({
							chainId: simulationFailureParams.chainId,
							blockNumber: blockNumber as bigint,
							from: sim.submitter,
							to: this.settlementAddress,
							calldata: sim.calldata,
						})
					: "";
				const { calldata: _calldata, ...logParams } = simulationFailureParams ?? {};
				this.logger.warn(
					{
						proposalId: proposal.id,
						orderUid: proposal.orderUid,
						revertReason,
						...logParams,
						tenderlyUrl,
					},
					"simulation revert",
				);
			}

			return { kind: "simFailed", simulationFailureParams, revertReason };
		}

		// Step 9: Parse Executed event — reject if missing
		const simulationBuyAmount = parseExecutedDelta(call.logs, trampoline);
		if (simulationBuyAmount === null) {
			return { kind: "reject", reason: "SimulationMissingExecutedEvent" };
		}

		const gas = BigInt(call.gasUsed);

		// Gate 2: cumulative collateral exposure check (CIP-87).
		//
		// Per-proposal penalty cap follows the deployment policy:
		//   penaltyCap(o) = min(collateralRatioBps / 10_000 × sellAmountNative, minCollateral)
		// minCollateral is the deployment absolute bound (ADR-0003).
		//
		// adjustedBalance = effectiveBalance − max(outstandingBufferBalance, 0)
		// Gate passes iff: adjustedBalance >= Σ (penaltyCap(o) + simulatedGas × gasPrice)
		//   summed over all active proposals for this subsolver, including this one.
		{
			const [inflightResult, balanceResult] = await collateralReads;
			if (inflightResult.status === "rejected" || balanceResult.status === "rejected") return null;
			const inflightData = inflightResult.value;
			const escrowBalance = balanceResult.value;

			// Sum exposure of all already-submitted proposals for this sub-solver.
			// The current candidate is not yet in the DB, so it is not included here.
			let siblingExposure = 0n;
			for (const p of inflightData.proposals) {
				const cap = penaltyCap(p.sellAmountNative, this.collateralRatioBps, this.minCollateral);
				const siblingGas = p.gasUsed ?? ESCROW_GAS_ESTIMATION;
				siblingExposure += cap + siblingGas * gasPrice;
			}

			// Current proposal's contribution.
			const currentExposure =
				perProposalCL(
					proposal.sellAmount,
					sellTokenRefPrice,
					this.collateralRatioBps,
					this.minCollateral,
				) +
				gas * gasPrice;
			const adjustedBalance = availableCollateral(escrowBalance, inflightData.bufferBalance);
			if (siblingExposure + currentExposure > adjustedBalance) {
				return { kind: "reject", reason: "ExposureCapExceeded" };
			}
		}

		// Step 10: Profitability gate (first validation only).
		// effectiveBuyAmount() inside profitability() uses simulationBuyAmount
		// once it is set on the proposal — we attach it here temporarily.
		const proposalWithSim: Proposal = { ...proposal, simulationBuyAmount };
		if (proposal.status === "submitted") {
			const profitResult = this.profitability(proposalWithSim, record, gas, surplusPrice, gasPrice);
			if (profitResult === "unprofitable") {
				return { kind: "reject", reason: "Unprofitable" };
			}
		}

		return {
			kind: "accept",
			simulation: {
				gasUsed: gas,
				trampoline,
				sellToken: record.order.sellToken,
				buyToken: record.order.buyToken,
				simulationBuyAmount,
				sellTokenRefPrice,
			},
		};
	}
}

/** Composes EscrowValidator (cheap, cached) + SimulationValidator (expensive, RPC). */
export class ProposalValidator implements ValidateProposal {
	constructor(
		private readonly escrow: EscrowValidator,
		private readonly simulation: SimulationValidator,
	) {}

	/** Clear the escrow balance cache at the start of each auction window. */
	beginAuction(): void {
		this.escrow.beginAuction();
		// Trampoline cache in simulation is persistent (no clearing)
	}

	/** Prefetch escrow balances for all known sub-solvers via multicall. */
	async prefetchBalances(addresses: Address[]): Promise<void> {
		await this.escrow.prefetchBalances(addresses);
	}

	async validate(proposal: Proposal): Promise<Verdict | null> {
		// Escrow first (cheap, cached)
		const escrowVerdict = await this.escrow.validate(proposal);
		if (escrowVerdict?.kind !== "accept") {
			return escrowVerdict;
		}

		// Simulation (expensive, RPC)
		return this.simulation.validate(proposal);
	}
}

/** Checks if an error is an EVM execution revert (RPC error code 3). */
function isRevertError(e: unknown): boolean {
	if (typeof e !== "object" || e === null) return false;
	const err = e as Record<string, unknown>;

	if ("code" in err && err.code === 3) return true;
	if ("name" in err && err.name === "ContractFunctionRevertedError") return true;
	if ("cause" in err && isRevertError(err.cause)) return true;

	return false;
}

/**
 * Extracts a revert reason from a thrown viem error (used for trampoline
 * resolution failures — not for eth_simulateV1 reverts).
 */
function extractRevertReasonFromThrown(e: unknown): string | null {
	if (typeof e !== "object" || e === null) return null;
	const err = e as Record<string, unknown>;

	if (err.name === "ContractFunctionRevertedError" && typeof err.reason === "string") {
		return err.reason;
	}

	if (err.code === 3 && typeof err.data === "string" && err.data.startsWith("0x08c379a0")) {
		return extractRevertReasonFromHex(err.data as Hex);
	}

	if ("cause" in err) return extractRevertReasonFromThrown(err.cause);

	return null;
}
