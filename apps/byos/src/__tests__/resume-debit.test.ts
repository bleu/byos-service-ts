import { describe, expect, it } from "vitest";
import { parseDebitOperationId } from "../infra/cli/resume-debit.js";

describe("parseDebitOperationId", () => {
	it("accepts one positive integer", () => {
		expect(parseDebitOperationId(["42"])).toBe(42);
	});

	it.each([[[]], [["0"]], [["-1"]], [["1.5"]], [["abc"]], [["1", "2"]]])(
		"rejects invalid arguments %#",
		(args) => {
			expect(() => parseDebitOperationId(args)).toThrow();
		},
	);
});
