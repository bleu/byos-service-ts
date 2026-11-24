import {
	createFyndClient,
	FyndClient,
	FyndError,
	type Quote,
	type QuoteParams,
} from "@kayibal/fynd-client";
import { z } from "zod";
import { type AuctionWork, requestSignal } from "./auction-work.js";

const amount = z.string().regex(/^\d+$/);
const address = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/)
	.transform((value) => value as `0x${string}`);
const hex = z
	.string()
	.regex(/^0x[0-9a-fA-F]*$/)
	.transform((value) => value as `0x${string}`);
const responseSchema = z.object({
	orders: z.array(
		z.object({
			order_id: z.string(),
			status: z.enum([
				"success",
				"no_route_found",
				"insufficient_liquidity",
				"timeout",
				"not_ready",
				"price_check_failed",
				"encoding_failed",
			]),
			amount_in: amount,
			amount_out: amount,
			gas_estimate: amount,
			block: z.object({
				number: z.number().int().nonnegative(),
				hash: z.string(),
				timestamp: z.number().nonnegative(),
			}),
			route: z
				.object({
					swaps: z.array(
						z.object({
							component_id: z.string(),
							protocol: z.string(),
							token_in: address,
							token_out: address,
							amount_in: amount,
							amount_out: amount,
							gas_estimate: amount,
						}),
					),
				})
				.nullish(),
			transaction: z.object({ to: address, data: hex, value: amount }).nullish(),
			fee_breakdown: z
				.object({
					router_fee: amount,
					client_fee: amount,
					max_slippage: amount,
					min_amount_received: amount,
				})
				.nullish(),
		}),
	),
});

/** Routing-only adapter: the SDK's high-level quote method cannot accept an abort signal. */
export function createFyndRoutingClient(baseUrl: string) {
	const sdk = new FyndClient({ baseUrl, timeoutMs: 7000, retry: { maxAttempts: 2 } });
	const http = createFyndClient(baseUrl);
	return {
		info: () => sdk.info(),
		health: () => sdk.health(),
		async quote(params: QuoteParams, work?: AuctionWork): Promise<Quote> {
			if (!work) return sdk.quote(params);
			const encoding = params.options?.encodingOptions;
			const filter = params.options?.routeFilter;
			if (encoding?.clientFeeParams || encoding?.permit || encoding?.permit2Signature) {
				throw FyndError.config("Routing client does not support client-fee or Permit2 signatures");
			}
			const { data, error } = await http.POST("/v1/quote", {
				signal: requestSignal(work),
				body: {
					orders: [
						{
							token_in: params.order.tokenIn,
							token_out: params.order.tokenOut,
							amount: params.order.amount.toString(),
							side: "sell",
							sender: params.order.sender,
							receiver: params.order.receiver ?? params.order.sender,
						},
					],
					options: {
						timeout_ms: Math.max(
							1,
							Math.min(5000, work.deadlineMs - work.deadlineBufferMs - Date.now() - 100),
						),
						...(encoding
							? {
									encoding_options: {
										// The deployed server accepts decimal strings; the generated schema says number.
										slippage: encoding.slippage.toString(),
										transfer_type:
											encoding.transferType === "none" ? undefined : encoding.transferType,
									},
								}
							: {}),
						...(filter
							? {
									route_filter: {
										exclude_pools: filter.excludePools,
										exclude_protocols: filter.excludeProtocols,
										exclude_tokens: filter.excludeTokens,
										require_tokens: filter.requireTokens,
									},
								}
							: {}),
					},
				},
			});
			if (error)
				throw FyndError.fromWireError(error as Parameters<typeof FyndError.fromWireError>[0]);
			const q = responseSchema.parse(data).orders[0];
			if (!q) throw FyndError.config("server returned no order quote");
			return {
				orderId: q.order_id,
				status: q.status,
				backend: "fynd",
				amountIn: BigInt(q.amount_in),
				amountOut: BigInt(q.amount_out),
				gasEstimate: BigInt(q.gas_estimate),
				block: q.block,
				tokenOut: params.order.tokenOut,
				receiver: params.order.receiver ?? params.order.sender,
				...(q.route
					? {
							route: {
								swaps: q.route.swaps.map((swap) => ({
									componentId: swap.component_id,
									protocol: swap.protocol,
									tokenIn: swap.token_in as `0x${string}`,
									tokenOut: swap.token_out as `0x${string}`,
									amountIn: BigInt(swap.amount_in),
									amountOut: BigInt(swap.amount_out),
									gasEstimate: BigInt(swap.gas_estimate),
								})),
							},
						}
					: {}),
				...(q.transaction
					? {
							transaction: {
								to: q.transaction.to as `0x${string}`,
								data: q.transaction.data as `0x${string}`,
								value: BigInt(q.transaction.value),
							},
						}
					: {}),
				...(q.fee_breakdown
					? {
							feeBreakdown: {
								routerFee: BigInt(q.fee_breakdown.router_fee),
								clientFee: BigInt(q.fee_breakdown.client_fee),
								maxSlippage: BigInt(q.fee_breakdown.max_slippage),
								minAmountReceived: BigInt(q.fee_breakdown.min_amount_received),
							},
						}
					: {}),
			};
		},
	};
}
