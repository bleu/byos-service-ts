import type { OrderKind, SettlementInteraction, SigningScheme } from "@byos/common";
import {
	OrderKind as OrderKindEnum,
	OrderStatus,
	SigningScheme as SigningSchemeEnum,
} from "@byos/common";
import type { Redis } from "ioredis";
import type { Address, Hex } from "viem";
import type { OrderRecord } from "../domain/order.js";
import type { AuctionOrder } from "./api/types.js";

export interface AuctionState {
	auctionId: number;
	/** Keyed by lowercase order UID. */
	orders: Map<string, OrderRecord>;
	/** Keyed by lowercase token address. Value is native price scaled by 1e18. */
	prices: Map<string, bigint>;
}

// ── Configurable backend ─────────────────────────────────────────────────────

/**
 * Pluggable storage for auction state. Production uses the Redis backend so
 * every replica can read the state set by the replica that received /solve.
 * Tests use the default in-memory path (backend = null).
 */
export interface AuctionStateBackend {
	get(): Promise<AuctionState | null>;
	set(state: AuctionState): Promise<void>;
	clear(): Promise<void>;
	/**
	 * Atomically deletes the stored state only if its auctionId matches.
	 * Prevents a finishing /solve from clearing state that belongs to a different
	 * auction (e.g. an overlapping request or a quote request clearing a real one).
	 */
	clearIfOwned(auctionId: number): Promise<void>;
}

/** Process-local copy — set only on the replica that owns the current /solve. */
let current: AuctionState | null = null;
let backend: AuctionStateBackend | null = null;

/** Configure the shared backend once at startup. */
export function configureAuctionStateBackend(b: AuctionStateBackend): void {
	backend = b;
}

/**
 * Stores auction state both locally and in the shared backend.
 * The local copy is the fast path for the /solve replica; other replicas
 * read from the backend.
 */
export async function setAuctionState(state: AuctionState): Promise<void> {
	current = state;
	if (backend) await backend.set(state);
}

/**
 * Returns the active auction state, or null if no auction is open.
 * Fast path: uses the process-local copy when this replica owned /solve.
 * Slow path: reads from the shared backend (Redis) for other replicas.
 */
export async function getAuctionState(): Promise<AuctionState | null> {
	if (current) return current;
	if (!backend) return null;
	return backend.get();
}

/** Clears auction state locally and from the shared backend. */
export async function clearAuctionState(): Promise<void> {
	current = null;
	if (backend) await backend.clear();
}

/**
 * Clears auction state only if the stored state belongs to this auction.
 * Safe to call from any /solve request: a finishing request cannot wipe state
 * that was written by a concurrent request for a different auction.
 */
export async function clearAuctionStateIfOwned(auctionId: number): Promise<void> {
	if (current?.auctionId === auctionId) {
		current = null;
	}
	if (backend) await backend.clearIfOwned(auctionId);
}

// Test-only helpers — write directly to the module variable so tests stay
// synchronous and need no Redis connection.
export function _setLocalAuctionState(state: AuctionState): void {
	current = state;
}
export function _clearLocalAuctionState(): void {
	current = null;
}

// ── Redis backend ─────────────────────────────────────────────────────────────

const AUCTION_STATE_KEY = "byos:auction:state";
const AUCTION_TTL_SECS = 120;

// Narrow serialization types — bigints become decimal strings, Maps become arrays.
interface SerializedInteraction {
	target: string;
	value: string;
	callData: string;
}
interface SerializedOrder {
	sellToken: string;
	buyToken: string;
	receiver: string;
	sellAmount: string;
	buyAmount: string;
	validTo: number;
	appData: string;
	feeAmount: string;
	kind: string;
	partiallyFillable: boolean;
	signingScheme: string;
	signature: string;
}
interface SerializedOrderRecord {
	order: SerializedOrder;
	preInteractions: SerializedInteraction[];
	postInteractions: SerializedInteraction[];
	erc20Balances: boolean;
	status: string;
}
interface SerializedState {
	auctionId: number;
	orders: [string, SerializedOrderRecord][];
	prices: [string, string][];
}

function serializeInteraction(i: SettlementInteraction): SerializedInteraction {
	return { target: i.target, value: i.value.toString(), callData: i.callData };
}

function deserializeInteraction(i: SerializedInteraction): SettlementInteraction {
	return {
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	};
}

function serializeRecord(r: OrderRecord): SerializedOrderRecord {
	return {
		order: {
			sellToken: r.order.sellToken,
			buyToken: r.order.buyToken,
			receiver: r.order.receiver,
			sellAmount: r.order.sellAmount.toString(),
			buyAmount: r.order.buyAmount.toString(),
			validTo: r.order.validTo,
			appData: r.order.appData,
			feeAmount: r.order.feeAmount.toString(),
			kind: r.order.kind,
			partiallyFillable: r.order.partiallyFillable,
			signingScheme: r.order.signingScheme,
			signature: r.order.signature,
		},
		preInteractions: r.preInteractions.map(serializeInteraction),
		postInteractions: r.postInteractions.map(serializeInteraction),
		erc20Balances: r.erc20Balances,
		status: r.status,
	};
}

function deserializeRecord(r: SerializedOrderRecord): OrderRecord {
	return {
		order: {
			sellToken: r.order.sellToken as Address,
			buyToken: r.order.buyToken as Address,
			receiver: r.order.receiver as Address,
			sellAmount: BigInt(r.order.sellAmount),
			buyAmount: BigInt(r.order.buyAmount),
			validTo: r.order.validTo,
			appData: r.order.appData as Hex,
			feeAmount: BigInt(r.order.feeAmount),
			kind: r.order.kind as OrderKind,
			partiallyFillable: r.order.partiallyFillable,
			signingScheme: r.order.signingScheme as SigningScheme,
			signature: r.order.signature as Hex,
		},
		preInteractions: r.preInteractions.map(deserializeInteraction),
		postInteractions: r.postInteractions.map(deserializeInteraction),
		erc20Balances: r.erc20Balances,
		status: r.status as OrderStatus,
	};
}

function serializeState(state: AuctionState): string {
	const s: SerializedState = {
		auctionId: state.auctionId,
		orders: Array.from(state.orders.entries()).map(([k, v]) => [k, serializeRecord(v)]),
		prices: Array.from(state.prices.entries()).map(([k, v]) => [k, v.toString()]),
	};
	return JSON.stringify(s);
}

function deserializeState(data: string): AuctionState {
	const s = JSON.parse(data) as SerializedState;
	return {
		auctionId: s.auctionId,
		orders: new Map(s.orders.map(([k, v]) => [k, deserializeRecord(v)])),
		prices: new Map(s.prices.map(([k, v]) => [k, BigInt(v)])),
	};
}

export function createRedisAuctionStateBackend(redis: Redis): AuctionStateBackend {
	return {
		async get() {
			const data = await redis.get(AUCTION_STATE_KEY);
			if (!data) return null;
			return deserializeState(data);
		},
		async set(state) {
			await redis.set(AUCTION_STATE_KEY, serializeState(state), "EX", AUCTION_TTL_SECS);
		},
		async clear() {
			await redis.del(AUCTION_STATE_KEY);
		},
		async clearIfOwned(auctionId) {
			// Lua script: atomically delete only if the stored auctionId matches.
			// Prevents a finishing /solve from clearing state written by a concurrent
			// request for a different auction.
			const script = `
				local data = redis.call('GET', KEYS[1])
				if not data then return 0 end
				local ok, parsed = pcall(cjson.decode, data)
				if not ok or type(parsed) ~= 'table' then return 0 end
				if parsed.auctionId == tonumber(ARGV[1]) then
					return redis.call('DEL', KEYS[1])
				end
				return 0
			`;
			await redis.eval(script, 1, AUCTION_STATE_KEY, String(auctionId));
		},
	};
}

// ── auctionOrderToRecord ──────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function mapKind(kind: string): OrderKind {
	if (kind === "sell") return OrderKindEnum.SELL;
	if (kind === "buy") return OrderKindEnum.BUY;
	throw new Error(`unknown order kind: ${kind}`);
}

function mapSigningScheme(scheme: string): SigningScheme {
	switch (scheme) {
		case "eip712":
			return SigningSchemeEnum.Eip712;
		case "ethsign":
			return SigningSchemeEnum.EthSign;
		case "eip1271":
			return SigningSchemeEnum.Eip1271;
		case "presign":
			return SigningSchemeEnum.PreSign;
		default:
			throw new Error(`unknown signing scheme: ${scheme}`);
	}
}

/**
 * Converts a /solve AuctionOrder to an OrderRecord.
 *
 * The driver normalises EthFlow orders before sending: sell token is already
 * WETH and validTo is already 0xffffffff. No EthFlow detection needed here.
 *
 * Uses fullSellAmount/fullBuyAmount (the original signed amounts) rather than
 * sellAmount/buyAmount (which the driver may adjust for protocol fees). The
 * settlement trade must hash to what the user signed.
 *
 * For EIP-1271 orders, GPv2Settlement expects owner (20 bytes) || contract
 * signature. The driver sends owner separately; this function prepends it.
 *
 * For presign orders the driver sends an empty signature; GPv2Settlement's
 * recoverPreSigner requires the owner address, so we use that instead.
 */
export function auctionOrderToRecord(order: AuctionOrder): OrderRecord {
	const erc20Balances = order.sellTokenSource === "erc20" && order.buyTokenDestination === "erc20";

	const preInteractions: SettlementInteraction[] = order.preInteractions.map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	const postInteractions: SettlementInteraction[] = order.postInteractions.map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	let signature: Hex;
	if (order.signingScheme === "presign") {
		// GPv2Settlement.recoverPreSigner requires the owner address (20 bytes).
		signature = order.owner as Hex;
	} else if (order.signingScheme === "eip1271") {
		// GPv2Settlement expects: owner (20 bytes) || contract signature.
		// The driver sends these separately; concatenate them here.
		signature = `0x${order.owner.slice(2)}${order.signature.slice(2)}` as Hex;
	} else {
		signature = order.signature as Hex;
	}

	return {
		order: {
			sellToken: order.sellToken as Address,
			buyToken: order.buyToken as Address,
			receiver: (order.receiver ?? ZERO_ADDRESS) as Address,
			// fullSellAmount/fullBuyAmount are the originally signed amounts.
			// The driver's sellAmount/buyAmount may be adjusted for protocol fees
			// and would produce a different order hash, breaking signature verification.
			sellAmount: BigInt(order.fullSellAmount),
			buyAmount: BigInt(order.fullBuyAmount),
			validTo: order.validTo,
			appData: order.appData as Hex,
			feeAmount: 0n,
			kind: mapKind(order.kind),
			partiallyFillable: order.partiallyFillable,
			signingScheme: mapSigningScheme(order.signingScheme),
			signature,
		},
		preInteractions,
		postInteractions,
		erc20Balances,
		status: OrderStatus.OPEN,
	};
}
