import type { PublicClient } from "viem";
import { type Address, erc20Abi, maxUint256 } from "viem";

/**
 * Tracks which (token, spender) pairs the trampoline has already approved.
 * Checks on-chain for unknown pairs; adds to the set if allowance is above
 * maxUint256 / 2 (a generous approval that will not need refreshing).
 */
export class ApprovalCache {
	private readonly approved = new Set<string>();

	/**
	 * Returns true if an on-chain approve(spender, maxUint256) interaction must be
	 * prepended to the proposal interactions for this token.
	 */
	async needsApproval(
		token: Address,
		trampoline: Address,
		spender: Address,
		publicClient: PublicClient,
	): Promise<boolean> {
		const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
		if (this.approved.has(key)) return false;
		const allowance = await publicClient.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [trampoline, spender],
		});
		if (allowance > maxUint256 / 2n) {
			this.approved.add(key);
			return false;
		}
		return true;
	}
}
