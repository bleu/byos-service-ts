import { describe, expect, it, vi } from "vitest";
import { buildProposalFromRoute } from "../proposal.js";

describe("buildProposalFromRoute", () => {
	it("signs the exact partial sell amount and provider minimum", async () => {
		const sign = vi.fn().mockResolvedValue("0x01");
		const proposal = await buildProposalFromRoute(
			{
				uid: `0x${"01".repeat(56)}`,
				sellToken: "0x0000000000000000000000000000000000000001",
				buyToken: "0x0000000000000000000000000000000000000002",
				sellAmount: 67n,
				buyAmount: 68n,
				kind: "sell",
			},
			{ quoteBuyAmount: 80n, minBuyAmount: 68n, interactions: [] },
			160n,
			9n,
			{ chainId: 56 },
			sign,
		);
		expect(proposal).toMatchObject({ sellAmount: 67n, minBuyAmount: 68n, quoteBuyAmount: 80n });
		expect(sign).toHaveBeenCalledOnce();
	});
});
