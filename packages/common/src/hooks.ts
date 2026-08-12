import type { Address, Hex } from "viem";

/** A single hook: an external call the settlement executes on behalf of the user. */
export interface Hook {
	target: Address;
	callData: Hex;
	gasLimit: bigint;
}

/** Pre- and post-hooks attached to an order via fullAppData.metadata.hooks. */
export interface Hooks {
	pre: Hook[];
	post: Hook[];
}

export function isEmptyHooks(hooks: Hooks): boolean {
	return hooks.pre.length === 0 && hooks.post.length === 0;
}
