import { z } from "zod";

/** CoW driver's /solve auction request, mirroring solvers-dto. Fields the
 * handlers consume are validated strictly (they reach arithmetic or the
 * database); the rest only need their wire type. Unknown keys are stripped,
 * matching serde's tolerance for flattened kind-specific fields. */

const decimalString = z.string().regex(/^\d+$/);
const addressString = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const wireInteractionSchema = z.object({
	target: z.string(),
	value: z.string(),
	callData: z.string(),
});

export const auctionTokenSchema = z.object({
	referencePrice: decimalString.nullish(),
	availableBalance: z.string(),
	trusted: z.boolean(),
});

export type AuctionToken = z.infer<typeof auctionTokenSchema>;

export const auctionOrderSchema = z.object({
	uid: z.string().regex(/^0x[0-9a-fA-F]{112}$/),
	sellToken: addressString,
	buyToken: addressString,
	sellAmount: decimalString,
	fullSellAmount: decimalString,
	buyAmount: decimalString,
	fullBuyAmount: decimalString,
	validTo: z.number(),
	kind: z.enum(["sell", "buy"]),
	owner: z.string(),
	partiallyFillable: z.boolean(),
	preInteractions: z.array(wireInteractionSchema),
	postInteractions: z.array(wireInteractionSchema),
	sellTokenSource: z.string(),
	buyTokenDestination: z.string(),
	class: z.string(),
	appData: z.string(),
	signingScheme: z.string(),
	signature: z.string(),
});

export type AuctionOrder = z.infer<typeof auctionOrderSchema>;

export const auctionSchema = z.object({
	// Absent on quote requests, which are never settled.
	id: z.string().nullish(),
	tokens: z.record(auctionTokenSchema),
	orders: z.array(auctionOrderSchema),
	effectiveGasPrice: decimalString,
	deadline: z.string(),
	surplusCapturingJitOrderOwners: z.array(z.string()).nullish(),
});

export type Auction = z.infer<typeof auctionSchema>;

/** Solution response types for /solve. */

export interface SolutionInteraction {
	kind: "custom";
	target: string;
	value: string;
	callData: string;
	internalize: boolean;
	allowances: unknown[];
	inputs: unknown[];
	outputs: unknown[];
}

export interface Fulfillment {
	kind: "fulfillment";
	order: string;
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

/** Driver notification for /notify. `kind` stays a free string so kinds
 * added upstream keep deserializing; ids may be null or absent entirely on
 * pre-solution kinds. The tx hash is strict — it is persisted and served
 * back on owner reads. */

export const notificationSchema = z.object({
	auctionId: z.string().nullish(),
	solutionId: z
		.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])
		.nullish(),
	kind: z.string(),
	transaction: z
		.string()
		.regex(/^0x[0-9a-fA-F]{64}$/)
		.nullish(),
});

export type Notification = z.infer<typeof notificationSchema>;
