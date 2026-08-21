import { OrderKind, TrampolineFactoryAbi } from "@byos/common";
import type { Address, PublicClient } from "viem";
import { checkEnvelope, type OrderRecord } from "../../domain/order.js";
import type { Proposal } from "../../domain/proposal.js";
import {
	type Candidate,
	effectiveGas,
	scaledToFill,
	scoreProposal,
	surplusToken,
} from "../../domain/scoring.js";
import type { ValidateProposal, Verdict } from "../../domain/validator.js";
import type { FetchOrder, OrderbookError } from "../orderbook.js";
import type { EscrowValidator, GasPriceRef } from "./escrow.js";
import { buildSimulation, DUMMY_SUBMITTER } from "./simulation.js";

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
			proposalBuy: proposal.quoteBuyAmount,
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
		// Step 1: Fetch order from orderbook
		let record: OrderRecord;
		try {
			record = await this.orderbook.order(proposal.orderUid);
		} catch (e) {
			const err = e as OrderbookError;
			if (err.kind === "notFound") {
				return { kind: "reject", reason: "OrderNotFound" };
			}
			return null; // transient, defer
		}

		// Step 2: Check envelope validity
		const envelopeReason = checkEnvelope(record, proposal);
		if (envelopeReason) {
			return { kind: "reject", reason: envelopeReason };
		}

		// Step 3: Resolve trampoline address
		let trampoline: Address;
		try {
			trampoline = proposal.trampoline ?? (await this.resolveTrampoline(proposal.subSolver));
		} catch (e) {
			if (isRevertError(e)) return { kind: "simFailed" };
			return null; // transport error, defer
		}

		// Step 4: Resolve authenticator
		let authenticator: Address;
		try {
			authenticator = await this.resolveAuthenticator();
		} catch {
			return null; // defer (authenticator() cannot revert)
		}

		// Step 5: Build simulation
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
		});

		// Step 6: Dispatch eth_estimateGas with state overrides
		let gas: bigint;
		try {
			gas = await this.publicClient.estimateGas({
				account: DUMMY_SUBMITTER,
				to: this.settlementAddress,
				data: sim.calldata,
				stateOverride: sim.stateOverride,
			});
		} catch (e) {
			if (isRevertError(e)) return { kind: "simFailed" };
			return null; // transport error, defer
		}

		// Step 7: Profitability gate (first validation only)
		if (proposal.status === "submitted") {
			const profitResult = await this.profitability(proposal, record, gas);
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

	// viem wraps RPC errors with details
	if ("code" in err && err.code === 3) return true;

	// viem ContractFunctionRevertedError
	if ("name" in err && err.name === "ContractFunctionRevertedError") return true;

	// viem EstimateGasExecutionError wrapping a revert
	if ("cause" in err && isRevertError(err.cause)) return true;

	return false;
}
