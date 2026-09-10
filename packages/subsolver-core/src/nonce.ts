import { randomBytes } from "node:crypto";

/** Returns an unbiased cryptographic uint256 nonce for a signed proposal. */
export function randomNonce(): bigint {
	return BigInt(`0x${randomBytes(32).toString("hex")}`);
}
