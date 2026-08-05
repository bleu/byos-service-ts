import { type Address, concat, getAddress, type Hex, keccak256, pad } from "viem";

const FEE_NUMERATOR = 997n;
const FEE_DENOMINATOR = 1000n;

/**
 * Uniswap V2 constant-product output amount (0.3% fee).
 * Returns null if reserves are zero or result is zero.
 */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
	if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return null;
	const amountInWithFee = amountIn * FEE_NUMERATOR;
	const numerator = amountInWithFee * reserveOut;
	const denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
	const out = numerator / denominator;
	return out > 0n ? out : null;
}

/**
 * Uniswap V2 constant-product input amount (inverse, ceil div).
 * Returns null if amountOut >= reserveOut or reserves are zero.
 */
export function amountIn(
	amountOutVal: bigint,
	reserveIn: bigint,
	reserveOut: bigint,
): bigint | null {
	if (reserveIn === 0n || reserveOut === 0n || amountOutVal === 0n) return null;
	if (amountOutVal >= reserveOut) return null;
	const numerator = reserveIn * amountOutVal * FEE_DENOMINATOR;
	const denominator = (reserveOut - amountOutVal) * FEE_NUMERATOR;
	// Ceil div
	return numerator / denominator + 1n;
}

/**
 * Deterministic Uniswap V2 pair address via CREATE2.
 * Tokens are sorted — (tokenA, tokenB) and (tokenB, tokenA) produce the same address.
 */
export function pairAddress(
	factory: Address,
	initCodeHash: Hex,
	tokenA: Address,
	tokenB: Address,
): Address {
	const [token0, token1] =
		tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
	const salt = keccak256(
		concat([pad(token0 as Hex, { size: 20 }), pad(token1 as Hex, { size: 20 })]),
	);

	// CREATE2: keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
	const data = concat(["0xff" as Hex, pad(factory as Hex, { size: 20 }), salt, initCodeHash]);
	const hash = keccak256(data);
	return getAddress(`0x${hash.slice(26)}`) as Address;
}
