import { evmChainFor } from "@byos/common";
import type { Address } from "viem";
import { custom, encodeAbiParameters, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { createSharedPublicClient } from "../context.js";
import { EscrowValidator } from "../infra/blockchain/escrow.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as Address;
const valueAbi = parseAbi(["function value() view returns (uint256)"]);

describe("shared public client", () => {
	it("batches concurrent contract reads into one Multicall3 eth_call", async () => {
		let ethCalls = 0;
		const client = createSharedPublicClient(
			evmChainFor(1),
			custom({
				async request({ method }: { method: string }) {
					if (method !== "eth_call") throw new Error(`unexpected RPC method ${method}`);
					ethCalls++;
					return encodeAbiParameters(
						[
							{
								components: [
									{ name: "success", type: "bool" },
									{ name: "returnData", type: "bytes" },
								],
								type: "tuple[]",
							},
						],
						[
							[
								{ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [1n]) },
								{ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [2n]) },
							],
						],
					);
				},
			}),
		);

		const values = await Promise.all(
			[1, 2].map(() =>
				client.readContract({ address: TARGET, abi: valueAbi, functionName: "value" }),
			),
		);

		expect(values).toEqual([1n, 2n]);
		expect(ethCalls).toBe(1);
	});
});

it("reads 50 distinct validation balances with one real Multicall3 RPC and reuses them", async () => {
	let ethCalls = 0;
	const client = createSharedPublicClient(
		evmChainFor(1),
		custom({
			async request({ method }: { method: string }) {
				if (method !== "eth_call") throw new Error(`unexpected RPC method ${method}`);
				ethCalls++;
				return encodeAbiParameters(
					[
						{
							type: "tuple[]",
							components: [
								{ name: "success", type: "bool" },
								{ name: "returnData", type: "bytes" },
							],
						},
					],
					[
						Array.from({ length: 50 }, (_, i) => ({
							success: true,
							returnData: encodeAbiParameters([{ type: "uint256" }], [BigInt(i)]),
						})),
					],
				);
			},
		}),
	);
	const escrow = new EscrowValidator(client, TARGET, 0n);
	const addresses = Array.from(
		{ length: 50 },
		(_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
	);
	const balances = await Promise.all(addresses.map((address) => escrow.getBalance(address)));
	expect(balances).toEqual(Array.from({ length: 50 }, (_, i) => BigInt(i)));
	expect(ethCalls).toBe(1);
	await Promise.all(addresses.map((address) => escrow.getBalance(address)));
	expect(ethCalls).toBe(1);
});
