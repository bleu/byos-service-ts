import { describe, expect, it } from "vitest";
import { batchSolutions, type SelectedSolution } from "../solution-batches.js";

function candidate(
	id: number,
	prices: Record<string, string>,
	subSolver = "alice",
): SelectedSolution {
	return {
		proposalId: id,
		subSolver,
		buyTokenRefPrice: "1",
		solution: {
			id,
			prices,
			trades: [{ kind: "fulfillment", order: `order-${id}`, executedAmount: "10", fee: "0" }],
			pre_interactions: [id],
			interactions: [],
			post_interactions: [id],
			gas: 100,
		},
	};
}

describe("same-sub-solver batches", () => {
	it("combines proportional clearing prices while preserving trades and hooks", () => {
		const batches = batchSolutions([
			candidate(1, { a: "4", b: "2" }),
			candidate(2, { a: "6", b: "3" }),
		]);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.solution.prices).toEqual({ a: "2", b: "1" });
		expect(batches[0]?.solution.trades.map((trade) => trade.order)).toEqual(["order-1", "order-2"]);
		expect(batches[0]?.solution.pre_interactions).toEqual([1, 2]);
		expect(batches[0]?.solution.post_interactions).toEqual([1, 2]);
		expect(batches[0]?.solution.gas).toBe(200);
	});
	it("separates incompatible prices and different sub-solvers", () => {
		expect(
			batchSolutions([candidate(1, { a: "2", b: "1" }), candidate(2, { a: "3", b: "1" })]),
		).toHaveLength(2);
		expect(
			batchSolutions([candidate(1, { a: "2", b: "1" }), candidate(2, { a: "2", b: "1" }, "bob")]),
		).toHaveLength(2);
	});
	it("scales a new token pair using its shared token", () => {
		const batches = batchSolutions([
			candidate(1, { a: "2", b: "3" }),
			candidate(2, { b: "5", c: "7" }),
		]);
		expect(batches[0]?.solution.prices).toEqual({ a: "10", b: "15", c: "21" });
	});
});
