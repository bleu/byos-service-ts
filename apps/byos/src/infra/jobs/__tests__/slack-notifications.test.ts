import type { Redis } from "ioredis";
import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AuditKind } from "../../../domain/audit.js";
import type { Proposal } from "../../../domain/proposal.js";
import { buildNotification } from "../audit-worker.js";
import type { SlackFormatterContext } from "../../formatters.js";
import { postToSlack } from "../slack-worker.js";

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

function makeRedis(saddReturn: number): Redis {
	return { sadd: vi.fn().mockResolvedValue(saddReturn) } as unknown as Redis;
}

function sampleProposal(): Proposal {
	return {
		id: 1,
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [
			{
				target: "0x0000000000000000000000000000000000000001" as Address,
				value: 5n,
				callData: "0x" as Hex,
			},
		],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: 1_700_000_000n,
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
	};
}

const testCtx: SlackFormatterContext = {
	chainId: 1,
	cowExplorerUrl: "https://explorer.cow.fi",
};

async function send(kind: AuditKind, redis: Redis = makeRedis(1)): Promise<string | null> {
	const text = await buildNotification(redis, kind, testCtx);
	if (text && SLACK_TOKEN && SLACK_CHANNEL) {
		await postToSlack(SLACK_TOKEN, SLACK_CHANNEL, text);
	}
	return text;
}

describe.skipIf(!SLACK_TOKEN || !SLACK_CHANNEL)("Slack notification integration", () => {
	it("new subsolver connected", async () => {
		const kind: AuditKind = { type: "received", proposal: sampleProposal() };
		const text = await send(kind, makeRedis(1));
		expect(text).toContain("New subsolver connected");
		expect(text).toContain(sampleProposal().subSolver);
	});

	it("known subsolver sends no message", async () => {
		const kind: AuditKind = { type: "received", proposal: sampleProposal() };
		const text = await send(kind, makeRedis(0));
		expect(text).toBeNull();
	});

	it("proposal settled", async () => {
		const txHash = `0x${"aa".repeat(32)}` as Hex;
		const kind: AuditKind = {
			type: "statusChanged",
			proposalId: 1,
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			orderUid: `0x${"ab".repeat(56)}`,
			from: "executing",
			to: "settled",
			rejectionReason: null,
			settlementTxHash: txHash,
		};
		const text = await send(kind);
		expect(text).toContain("Auction won");
		expect(text).toContain(txHash);
	});

	it("settlement reverted", async () => {
		const txHash = `0x${"bb".repeat(32)}` as Hex;
		const kind: AuditKind = {
			type: "statusChanged",
			proposalId: 2,
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			orderUid: `0x${"ab".repeat(56)}`,
			from: "executing",
			to: "settleFailed",
			rejectionReason: null,
			settlementTxHash: txHash,
		};
		const text = await send(kind);
		expect(text).toContain("Settlement reverted");
		expect(text).toContain(txHash);
	});

	it("subsolver penalized", async () => {
		const kind: AuditKind = {
			type: "penalized",
			proposalId: 3,
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			orderUid: `0x${"ab".repeat(56)}`,
			amount: 10_000_000_000_000_000n,
			settlementTxHash: `0x${"22".repeat(32)}` as Hex,
			penaltyTxHash: `0x${"77".repeat(32)}` as Hex,
		};
		const text = await send(kind);
		expect(text).toContain("Subsolver penalized");
		expect(text).toContain("0.01 ETH");
	});

	it("non-settlement debited", async () => {
		const kind: AuditKind = {
			type: "nonSettlementDebited",
			proposalId: 4,
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			orderUid: `0x${"ab".repeat(56)}`,
			amount: 5_000_000_000_000_000n,
			penaltyTxHash: `0x${"88".repeat(32)}` as Hex,
		};
		const text = await send(kind);
		expect(text).toContain("non-settlement debited");
		expect(text).toContain("0.005 ETH");
	});

	it("BYOS buffer debited", async () => {
		const kind: AuditKind = {
			type: "bufferDebited",
			subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
			amount: 20_000_000_000_000_000n,
			clearTxHash: `0x${"99".repeat(32)}` as Hex,
			entryCount: 3,
		};
		const text = await send(kind);
		expect(text).toContain("buffer debited");
		expect(text).toContain("0.02 ETH");
		expect(text).toContain("3");
	});
});
