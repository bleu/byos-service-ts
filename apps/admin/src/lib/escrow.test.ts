import { afterEach, describe, expect, it, vi } from "vitest";

const { multicall, createClient } = vi.hoisted(() => {
	const multicall = vi.fn();
	return { multicall, createClient: vi.fn((_options: unknown) => ({ multicall })) };
});
vi.mock("viem", async (importOriginal) => ({
	...(await importOriginal<typeof import("viem")>()),
	createPublicClient: createClient,
}));

import { getEscrowBalances } from "./escrow.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("admin escrow chain configuration", () => {
	it.each(["43114", "56"])("configures multicall for chain %s", async (chainId) => {
		vi.stubEnv("CHAIN_ID", chainId);
		vi.stubEnv("RPC_URL", "http://rpc.invalid");
		vi.stubEnv("ESCROW_ADDRESS", `0x${"11".repeat(20)}`);
		vi.stubEnv("USE_MOCKED_DATA", "false");
		const address = `0x${"22".repeat(20)}` as const;
		multicall.mockResolvedValue([{ status: "success", result: 2n }]);
		expect(await getEscrowBalances([address])).toEqual(new Map([[address, 2n]]));
		expect(createClient).toHaveBeenCalledWith(
			expect.objectContaining({
				chain: expect.objectContaining({
					id: Number(chainId),
					contracts: expect.objectContaining({
						multicall3: expect.objectContaining({ address: expect.stringMatching(/^0x/) }),
					}),
				}),
			}),
		);
	});
});
