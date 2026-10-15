const NATIVE_PRICE_SCALE = 10n ** 18n;

/**
 * Per-proposal penalty cap (cL) following CIP-87:
 *   cL = min(collateralRatioBps / 10_000 × sellAmountNative, minCollateral)
 * where minCollateral is c̄ (~$20 USD absolute bound).
 * Mirrors the Gate 2 formula in SimulationValidator — both sides use the same cap.
 */
export function perProposalCL(
	sellAmount: string,
	sellTokenRefPrice: string | null,
	collateralRatioBps: bigint,
	minCollateral: bigint,
): bigint {
	if (!sellTokenRefPrice || sellTokenRefPrice === "0") return minCollateral;
	const sellAmountNative = (BigInt(sellAmount) * BigInt(sellTokenRefPrice)) / NATIVE_PRICE_SCALE;
	const scaled = (sellAmountNative * collateralRatioBps) / 10_000n;
	return scaled < minCollateral ? scaled : minCollateral;
}
