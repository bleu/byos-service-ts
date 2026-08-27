import { describe, expect, it } from "vitest";
import { prioritizeCandidates, toCandidateOrder } from "../polling.js";

const order = {
	uid: "0x01",
	chainId: 56,
	sellToken: "0x0000000000000000000000000000000000000001" as const,
	buyToken: "0x0000000000000000000000000000000000000002" as const,
	fullSellAmount: 100n,
	fullBuyAmount: 101n,
	executedSellAmount: 33n,
};

describe("shared polling helpers", () => {
	it("calculates remaining sell and a ceiling-scaled buy floor", () => {
		expect(toCandidateOrder(order)).toMatchObject({ remainingSell: 67n, scaledLimitBuy: 68n });
	});

	it("prioritizes new proposals and then native surplus", () => {
		const ranked = prioritizeCandidates(
			[
				{ ...order, uid: "0x01", estimatedNativeSurplus: 2n },
				{ ...order, uid: "0x02", estimatedNativeSurplus: 9n },
				{ ...order, uid: "0x03", estimatedNativeSurplus: 1n },
			],
			(uid) => uid === "0x02",
		);
		expect(ranked.map((candidate) => candidate.candidate.uid)).toEqual(["0x01", "0x03", "0x02"]);
	});
});
