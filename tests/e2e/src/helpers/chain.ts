/**
 * Anvil chain manipulation helpers (viem-based).
 * Ported from offline-mode/test/utils/anvil-helpers.ts (ethers → viem).
 */
import type { Hex, PublicClient } from "viem";

export async function takeSnapshot(client: PublicClient): Promise<Hex> {
	return client.request({ method: "evm_snapshot" as "eth_chainId" }) as Promise<Hex>;
}

export async function revertSnapshot(client: PublicClient, id: Hex): Promise<void> {
	await client.request({ method: "evm_revert" as "eth_chainId", params: [id] as never });
}

export async function mineBlock(client: PublicClient): Promise<void> {
	await client.request({ method: "evm_mine" as "eth_chainId" });
}

export async function advanceTime(client: PublicClient, seconds: number): Promise<void> {
	await client.request({
		method: "evm_increaseTime" as "eth_chainId",
		params: [seconds] as never,
	});
	await mineBlock(client);
}
