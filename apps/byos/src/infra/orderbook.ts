import type { SettlementInteraction } from "@byos/common";
import { type CowOrder, OrderKind, SigningScheme } from "@byos/common";
import type { Address, Hex } from "viem";
import type { OrderRecord } from "../domain/order.js";

// --- Error ---

export type OrderbookError = { kind: "notFound" } | { kind: "transient"; message: string };

// --- Interface ---

export interface FetchOrder {
	order(uid: string): Promise<OrderRecord>;
	nativePrice(token: Address): Promise<bigint>;
}

// --- DTO types ---

interface InteractionDto {
	target: string;
	value: string;
	callData: string;
}

interface OrderInteractionsDto {
	pre?: InteractionDto[];
	post?: InteractionDto[];
}

interface OrderDto {
	receiver?: string | null;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	buyAmount: string;
	feeAmount: string;
	validTo: number;
	appData: string;
	kind: string;
	partiallyFillable: boolean;
	sellTokenBalance: string;
	buyTokenBalance: string;
	signingScheme: string;
	signature: string;
	interactions?: OrderInteractionsDto;
}

// --- Client ---

const CACHE_CAPACITY = 10_000;
const ETHER = 10n ** 18n;

// Unknown enum values throw transient rather than coercing: the Rust DTO's
// closed serde enums fail deserialization, so the validator defers instead of
// mis-classifying the order.
function mapKind(kind: string): OrderKind {
	if (kind === "sell") return OrderKind.SELL;
	if (kind === "buy") return OrderKind.BUY;
	throw { kind: "transient", message: `unknown order kind ${kind}` } satisfies OrderbookError;
}

function mapSigningScheme(scheme: string): SigningScheme {
	switch (scheme) {
		case "eip712":
			return SigningScheme.Eip712;
		case "ethsign":
			return SigningScheme.EthSign;
		case "eip1271":
			return SigningScheme.Eip1271;
		case "presign":
			return SigningScheme.PreSign;
		default:
			throw {
				kind: "transient",
				message: `unknown signing scheme ${scheme}`,
			} satisfies OrderbookError;
	}
}

function dtoToInteraction(dto: InteractionDto): SettlementInteraction {
	return {
		target: dto.target as Address,
		value: BigInt(dto.value),
		callData: dto.callData as Hex,
	};
}

function dtoToOrderRecord(dto: OrderDto): OrderRecord {
	const erc20Balances = dto.sellTokenBalance === "erc20" && dto.buyTokenBalance === "erc20";

	const order: CowOrder = {
		sellToken: dto.sellToken as Address,
		buyToken: dto.buyToken as Address,
		receiver: (dto.receiver ?? "0x0000000000000000000000000000000000000000") as Address,
		sellAmount: BigInt(dto.sellAmount),
		buyAmount: BigInt(dto.buyAmount),
		validTo: dto.validTo,
		appData: dto.appData as Hex,
		feeAmount: BigInt(dto.feeAmount),
		kind: mapKind(dto.kind),
		partiallyFillable: dto.partiallyFillable,
		signingScheme: mapSigningScheme(dto.signingScheme),
		signature: dto.signature as Hex,
	};

	return {
		order,
		preInteractions: (dto.interactions?.pre ?? []).map(dtoToInteraction),
		postInteractions: (dto.interactions?.post ?? []).map(dtoToInteraction),
		erc20Balances,
	};
}

export class OrderbookClient implements FetchOrder {
	private cache = new Map<string, OrderRecord>();
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	private remember(uid: string, record: OrderRecord): void {
		const key = uid.toLowerCase();
		if (this.cache.size >= CACHE_CAPACITY && !this.cache.has(key)) {
			this.cache.clear();
		}
		this.cache.set(key, record);
	}

	async order(uid: string): Promise<OrderRecord> {
		const key = uid.toLowerCase();
		const cached = this.cache.get(key);
		if (cached) return cached;

		const normalizedUid = uid.startsWith("0x") ? uid : `0x${uid}`;
		const url = `${this.baseUrl}/api/v1/orders/${normalizedUid}`;

		const response = await fetch(url);

		if (response.status === 404) {
			throw { kind: "notFound" } satisfies OrderbookError;
		}
		if (!response.ok) {
			throw {
				kind: "transient",
				message: `orderbook ${response.status}: ${await response.text()}`,
			} satisfies OrderbookError;
		}

		const dto = (await response.json()) as OrderDto;
		const record = dtoToOrderRecord(dto);

		this.remember(uid, record);
		return record;
	}

	async nativePrice(token: Address): Promise<bigint> {
		const url = `${this.baseUrl}/api/v1/token/${token}/native_price`;
		const response = await fetch(url);

		if (response.status === 404) {
			throw { kind: "notFound" } satisfies OrderbookError;
		}
		if (!response.ok) {
			throw {
				kind: "transient",
				message: `orderbook price ${response.status}`,
			} satisfies OrderbookError;
		}

		const dto = (await response.json()) as { price: number };
		if (!Number.isFinite(dto.price) || dto.price < 0) {
			throw {
				kind: "transient",
				message: `unusable native price ${dto.price}`,
			} satisfies OrderbookError;
		}

		// Convert to reference semantics: multiply by 1e18
		return BigInt(Math.floor(dto.price * Number(ETHER)));
	}
}
