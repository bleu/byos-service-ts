import pino from "pino";
import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { logValidationUnavailable } from "../validation-log.js";

const proposal = { id: 10, auctionId: 265198038, orderUid: "0x1234", subSolver: "0xabcd" } as const;

describe("validation error logging", () => {
	it("retains viem diagnostics without logging the RPC URL or request body", () => {
		const lines: string[] = [];
		const logger = pino(
			{},
			{
				write: (line) => {
					lines.push(line);
				},
			},
		);
		const cause = new HttpRequestError({
			url: "https://rpc.example/secret-api-key",
			body: { method: "eth_simulateV1", params: ["private-request-body"] },
			status: 429,
			details: "rate limit exceeded",
		});
		logValidationUnavailable(
			logger,
			proposal,
			"validation-exception",
			new Error("validation failed", { cause }),
		);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			proposalId: 10,
			auctionId: proposal.auctionId,
			stage: "validation-exception",
			error: {
				message: "validation failed",
				cause: { status: 429, details: "rate limit exceeded" },
			},
		});
		expect(lines[0]).not.toContain("secret-api-key");
		expect(lines[0]).not.toContain("private-request-body");
	});

	it("redacts URLs in plain errors and handles circular causes", () => {
		const lines: string[] = [];
		const logger = pino(
			{},
			{
				write: (line) => {
					lines.push(line);
				},
			},
		);
		const error = new Error("connection failed: https://user:secret@rpc.example/api-key");
		error.cause = error;
		logValidationUnavailable(logger, proposal, "eth_simulateV1", error);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("connection failed: [redacted RPC URL]");
		expect(lines[0]).not.toContain("secret");
		expect(lines[0]).not.toContain("api-key");
	});
});
