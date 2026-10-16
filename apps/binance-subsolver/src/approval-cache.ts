import type { PublicClient } from "viem";
import { type Address, erc20Abi, maxUint256 } from "viem";

/**
 * Tracks which sell tokens the trampoline has already approved for the Binance
 * router. Checks on-chain for unknown tokens; adds to the set if allowance is
 * above maxUint256 / 2 (a generous approval that will not need refreshing).
 */
export class ApprovalCache {
	private readonly approved = new Set<Address>();

	/**
	 * Returns true if an on-chain approve(router, maxUint256) interaction must be
	 * prepended to the proposal interactions for this token.
	 */
	async needsApproval(
		token: Address,
		trampoline: Address,
		router: Address,
		publicClient: PublicClient,
	): Promise<boolean> {
		if (this.approved.has(token)) return false;
		const allowance = await publicClient.readContract({
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [trampoline, router],
		});
		if (allowance > maxUint256 / 2n) {
			this.approved.add(token);
			return false;
		}
		return true;
	}
}
