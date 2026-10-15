const NATIVE_PRICE_SCALE = 10n ** 18n;

/** Native-token wei represented by a token-atom amount and normalized price. */
export function nativeSellValue(sellAmount: bigint, sellTokenRefPrice: bigint): bigint {
	return (sellAmount * sellTokenRefPrice) / NATIVE_PRICE_SCALE;
}

/** Deployment policy cap. Legacy unpriced exposure reserves the absolute cap. */
export function penaltyCap(
	sellAmountNative: bigint | null,
	collateralRatioBps: bigint,
	minCollateral: bigint,
): bigint {
	if (sellAmountNative === null) return minCollateral;
	const scaled = (sellAmountNative * collateralRatioBps) / 10_000n;
	return scaled < minCollateral ? scaled : minCollateral;
}

export function perProposalCL(
	sellAmount: bigint,
	sellTokenRefPrice: bigint | null,
	collateralRatioBps: bigint,
	minCollateral: bigint,
): bigint {
	const nativeValue =
		sellTokenRefPrice === null || sellTokenRefPrice <= 0n
			? null
			: nativeSellValue(sellAmount, sellTokenRefPrice);
	return penaltyCap(nativeValue, collateralRatioBps, minCollateral);
}

/** Delivery credits are not escrow available for gas or Track A penalties. */
export function availableCollateral(escrowBalance: bigint, bufferBalance: bigint): bigint {
	return escrowBalance - (bufferBalance > 0n ? bufferBalance : 0n);
}
