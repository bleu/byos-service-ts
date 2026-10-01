import { OrderKind, TrampolineAbi, TrampolineFactoryAbi } from "@byos/common";
import type { Logger } from "pino";
import type { Address, Hex, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { checkEnvelope, checkProposalSlippage, type OrderRecord } from "../../domain/order.js";
import { effectiveBuyAmount, type Proposal } from "../../domain/proposal.js";
import {
	type Candidate,
	effectiveGas,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import type { SimulationFailureParams, ValidateProposal, Verdict } from "../../domain/validator.js";
import type { FetchOrder, OrderbookError } from "../orderbook.js";
import type { EscrowValidator, GasPriceRef } from "./escrow.js";
import { buildSimulation } from "./simulation.js";

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
 * dRPC returns it in returnData for most reverts, falling back to error.data.
 */
function revertDataFrom(call: SimulateV1CallResult): Hex | undefined {
	if (call.returnData && call.returnData !== "0x") return call.returnData;
	return call.error?.data;
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
		private readonly orderbook: FetchOrder,
		private readonly settlementAddress: Address,
		private readonly escrowAddress: Address,
		private readonly trampolineFactory: Address,
		private readonly gasPriceRef: GasPriceRef,
		private readonly minScore: bigint,
		private readonly maxSlippageBps: bigint,
		private readonly maxSlippageNative: bigint,
		private readonly logger?: Logger,
		private readonly submitter?: Address,
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

	private async profitability(
		proposal: Proposal,
		record: OrderRecord,
		gas: bigint,
	): Promise<"ok" | "unprofitable" | null> {
		const isSellOrder = record.order.kind === OrderKind.SELL;
		const surplusTkn = surplusToken(isSellOrder, record.order.sellToken, record.order.buyToken);

		let surplusPrice: bigint;
		try {
			surplusPrice = await this.orderbook.nativePrice(surplusTkn);
		} catch (e) {
			const err = e as OrderbookError;
			if (err.kind === "notFound") return "unprofitable";
			return null; // transient, defer
		}

		const gasCost = effectiveGas(gas) * this.gasPriceRef.value;

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
		// Step 1: Fetch order + buy token native price in parallel.
		// nativePrice is only needed for the gap check (sell orders).
		// Errors are handled independently: order notFound → OrderNotFound,
		// price notFound on a sell order → fail closed (ProposedSlippageOutrange),
		// price unavailable on a buy order → use 0n (gap check skips buy orders),
		// any transient error → defer.
		const [orderResult, priceResult] = await Promise.allSettled([
			this.orderbook.order(proposal.orderUid),
			this.orderbook.nativePrice(proposal.buyToken),
		]);

		if (orderResult.status === "rejected") {
			const err = orderResult.reason as OrderbookError;
			if (err.kind === "notFound") return { kind: "reject", reason: "OrderNotFound" };
			return null; // transient, defer
		}
		const record = orderResult.value;

		let nativePrice: bigint;
		if (priceResult.status === "rejected") {
			const err = priceResult.reason as OrderbookError;
			if (record.order.kind === OrderKind.SELL) {
				// Sell orders need the price to evaluate the native-amount gap cap.
				// Fail closed: if price is missing we cannot assess, so reject.
				if (err.kind === "notFound") return { kind: "reject", reason: "NativePriceUnavailable" };
				return null; // transient, defer
			}
			// Buy orders skip the gap check entirely — price is not needed.
			nativePrice = 0n;
		} else {
			nativePrice = priceResult.value;
		}

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

		// Step 4: Resolve trampoline address
		let trampoline: Address;
		try {
			trampoline = proposal.trampoline ?? (await this.resolveTrampoline(proposal.subSolver));
		} catch (e) {
			if (isRevertError(e))
				return { kind: "simFailed", revertReason: extractRevertReasonFromThrown(e) ?? undefined };
			return null; // transport error, defer
		}

		// Step 5: Resolve authenticator
		let authenticator: Address;
		try {
			authenticator = await this.resolveAuthenticator();
		} catch {
			return null; // defer (authenticator() cannot revert)
		}

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
			const revertReason = extractRevertReasonFromHex(revertData) ?? undefined;

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

		// Step 10: Profitability gate (first validation only).
		// effectiveBuyAmount() inside profitability() uses simulationBuyAmount
		// once it is set on the proposal — we attach it here temporarily.
		const proposalWithSim: Proposal = { ...proposal, simulationBuyAmount };
		if (proposal.status === "submitted") {
			const profitResult = await this.profitability(proposalWithSim, record, gas);
			if (profitResult === "unprofitable") {
				return { kind: "reject", reason: "Unprofitable" };
			}
			if (profitResult === null) {
				return null; // defer
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

	beginTick(): void {
		this.escrow.beginTick();
		// Trampoline cache in simulation is persistent (no clearing)
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
