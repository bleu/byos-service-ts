type Address = `0x${string}`;
type ContractInteraction = { target: Address; value: bigint; callData: `0x${string}` };

/** An order candidate normalized by the shared polling pipeline. */
export interface CandidateOrder {
	uid: string;
	chainId: number;
	sellToken: Address;
	buyToken: Address;
	remainingSell: bigint;
	scaledLimitBuy: bigint;
}

/** A route a provider has quoted but not yet signed or submitted. */
export interface ProviderRoute {
	quoteBuyAmount: bigint;
	minBuyAmount: bigint;
	interactions: ContractInteraction[];
}

/**
 * Provider boundary for the reusable sub-solver pipeline. Implementations may
 * fail an individual order without interrupting the rest of a polling batch.
 */
export interface RouteProvider {
	readonly name: string;
	quote(order: CandidateOrder): Promise<ProviderRoute | null>;
}
