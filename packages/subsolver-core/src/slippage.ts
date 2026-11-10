import type { Address } from "viem";
import { CORRELATED_ASSETS } from "./correlated-assets.js";

export const DEFAULT_CORRELATED_SLIPPAGE_BPS = 5;

interface SlippageOptions {
	chainId: number;
	sellToken: Address;
	buyToken: Address;
	defaultSlippageBps: number;
	correlatedSlippageBps: number;
}

/** Unconfigured chains and pairs retain the provider's ordinary slippage. */
export function selectSlippageBps(options: SlippageOptions): number {
	const sellToken = options.sellToken.toLowerCase();
	const buyToken = options.buyToken.toLowerCase();
	const correlated = CORRELATED_ASSETS[options.chainId]?.some(
		(basket) =>
			basket.some((token) => token.toLowerCase() === sellToken) &&
			basket.some((token) => token.toLowerCase() === buyToken),
	);
	return correlated ? options.correlatedSlippageBps : options.defaultSlippageBps;
}
