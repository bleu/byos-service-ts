import { describe, expect, it } from "vitest";
import { RequestBudget } from "../request-budget.js";

describe("RequestBudget", () => {
	it("reserves request capacity for BYOS state reads", () => {
		let now = 0;
		const budget = new RequestBudget(3, 1, () => now);
		expect(budget.consumeSubmission()).toBe(true);
		expect(budget.consumeSubmission()).toBe(true);
		expect(budget.consumeSubmission()).toBe(false);
		now = 60_001;
		expect(budget.consumeSubmission()).toBe(true);
	});

	it("permits reads from the reserved capacity after submissions pause", () => {
		const budget = new RequestBudget(3, 1);
		expect(budget.consumeSubmission()).toBe(true);
		expect(budget.consumeSubmission()).toBe(true);
		expect(budget.consumeSubmission()).toBe(false);
		expect(budget.consumeRead()).toBe(true);
		expect(budget.consumeRead()).toBe(false);
	});
});
