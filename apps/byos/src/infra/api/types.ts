/** CoW driver's /solve auction request (manual types matching solvers-dto). */

export interface AuctionToken {
	referencePrice: string | null;
	availableBalance: string;
	trusted: boolean;
}

export interface AuctionOrder {
	uid: string;
	sellToken: string;
	buyToken: string;
	sellAmount: string;
	fullSellAmount: string;
	buyAmount: string;
	fullBuyAmount: string;
	validTo: number;
	kind: "sell" | "buy";
	owner: string;
	partiallyFillable: boolean;
	preInteractions: Array<{ target: string; value: string; callData: string }>;
	postInteractions: Array<{ target: string; value: string; callData: string }>;
	sellTokenSource: string;
	buyTokenDestination: string;
	class: string;
	appData: string;
	signingScheme: string;
	signature: string;
}

export interface Auction {
	id?: string;
	tokens: Record<string, AuctionToken>;
	orders: AuctionOrder[];
	effectiveGasPrice: string;
	deadline: string;
	surplusCapturingJitOrderOwners?: string[];
}

/** Solution response types for /solve. */

export interface SolutionInteraction {
	target: string;
	value: string;
	callData: string;
	internalize: boolean;
	allowances: unknown[];
	inputs: unknown[];
	outputs: unknown[];
}

export interface Fulfillment {
	orderUid: string;
	executedAmount: string;
	fee: string;
}

export interface Solution {
	id: number;
	prices: Record<string, string>;
	trades: Fulfillment[];
	pre_interactions: unknown[];
	interactions: SolutionInteraction[];
	post_interactions: unknown[];
	gas: number;
}

export interface SolveResponse {
	solutions: Solution[];
}

/** Driver notification for /notify. */

export interface Notification {
	auctionId?: string;
	solutionId: number | number[];
	kind: string;
	transaction?: string;
}
