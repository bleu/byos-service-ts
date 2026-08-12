import { EscrowAbi } from "@byos/common";
import {
	createPublicClient,
	createWalletClient,
	custom,
	decodeFunctionData,
	type Hex,
	parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { EscrowOperator } from "../operator.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const SUB_SOLVER = "0x0000000000000000000000000000000000000001";
const SETTLEMENT_TX: Hex = `0x${"22".repeat(32)}`;
const DEBIT_TX: Hex = `0x${"77".repeat(32)}`;
const DEBIT_AMOUNT = 16_000_000_000_000_000n; // 0.006 gas + 0.010 c_l

function receiptBody(hash: Hex, gasUsed: bigint, effectiveGasPrice: bigint, succeeded: boolean) {
	return {
		transactionHash: hash,
		transactionIndex: "0x0",
		blockHash: `0x${"bb".repeat(32)}`,
		blockNumber: "0x10",
		from: SUB_SOLVER,
		to: ESCROW,
		cumulativeGasUsed: `0x${gasUsed.toString(16)}`,
		gasUsed: `0x${gasUsed.toString(16)}`,
		effectiveGasPrice: `0x${effectiveGasPrice.toString(16)}`,
		contractAddress: null,
		logs: [],
		logsBloom: `0x${"00".repeat(256)}`,
		status: succeeded ? "0x1" : "0x0",
		type: "0x2",
	};
}

/**
 * Fake JSON-RPC node, mirroring the Rust test's wiremock responder: serves
 * the known settlement receipt (200_000 gas at 30 gwei), accepts the signed
 * debit (capturing its raw bytes), and confirms it as DEBIT_TX — reverted
 * when `debitSucceeds` is false.
 */
function fakeNode(opts?: { debitSucceeds?: boolean; nullReceipts?: boolean }) {
	const sent: { raw: Hex | null } = { raw: null };
	let blockNumber = 0x10;

	const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
		switch (method) {
			case "eth_chainId":
				return "0x1";
			case "eth_blockNumber":
				return `0x${(blockNumber++).toString(16)}`;
			case "eth_getTransactionCount":
				return "0x0";
			case "eth_estimateGas":
				return "0x186a0";
			case "eth_gasPrice":
			case "eth_maxPriorityFeePerGas":
				return "0x3b9aca00";
			case "eth_feeHistory":
				return {
					oldestBlock: "0xf",
					baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
					gasUsedRatio: [0.5],
					reward: [["0x3b9aca00"]],
				};
			case "eth_getBlockByNumber":
				return {
					number: `0x${blockNumber.toString(16)}`,
					hash: `0x${"bb".repeat(32)}`,
					parentHash: `0x${"aa".repeat(32)}`,
					timestamp: "0x65000000",
					baseFeePerGas: "0x3b9aca00",
					gasLimit: "0x1c9c380",
					gasUsed: "0x0",
					miner: `0x${"00".repeat(20)}`,
					difficulty: "0x0",
					totalDifficulty: "0x0",
					extraData: "0x",
					logsBloom: `0x${"00".repeat(256)}`,
					mixHash: `0x${"00".repeat(32)}`,
					nonce: "0x0000000000000000",
					receiptsRoot: `0x${"00".repeat(32)}`,
					sha3Uncles: `0x${"00".repeat(32)}`,
					size: "0x0",
					stateRoot: `0x${"00".repeat(32)}`,
					transactions: [],
					transactionsRoot: `0x${"00".repeat(32)}`,
					uncles: [],
				};
			case "eth_sendRawTransaction":
				sent.raw = (params as [Hex])[0];
				return DEBIT_TX;
			case "eth_getTransactionReceipt": {
				if (opts?.nullReceipts) return null;
				const hash = (params as [Hex])[0];
				if (hash === SETTLEMENT_TX) {
					// 200_000 gas at 30 gwei: 0.006 ETH on-chain cost.
					return receiptBody(SETTLEMENT_TX, 200_000n, 30_000_000_000n, true);
				}
				return receiptBody(DEBIT_TX, 50_000n, 1_000_000_000n, opts?.debitSucceeds !== false);
			}
			default:
				throw new Error(`unexpected RPC method ${method}`);
		}
	};

	return { transport: custom({ request }), sent };
}

function operatorAt(transport: ReturnType<typeof custom>): EscrowOperator {
	const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
	const publicClient = createPublicClient({ transport, pollingInterval: 10 });
	const walletClient = createWalletClient({ account, transport });
	return new EscrowOperator(walletClient, publicClient, ESCROW);
}

describe("EscrowOperator", () => {
	it("settlement cost is gas used times effective gas price", async () => {
		const node = fakeNode();
		const cost = await operatorAt(node.transport).settlementCost(SETTLEMENT_TX);

		// 200_000 gas at 30 gwei must price as 0.006 ETH.
		expect(cost).toBe(6_000_000_000_000_000n);
	});

	it("a reverted debit is a failure, not a landed charge", async () => {
		const node = fakeNode({ debitSucceeds: false });

		await expect(
			operatorAt(node.transport).debit(SUB_SOLVER, DEBIT_AMOUNT, SETTLEMENT_TX),
		).rejects.toThrow(/reverted/);

		// The tx was submitted — the failure is the receipt, not the send.
		expect(node.sent.raw).not.toBeNull();
	});

	it("debit submits the signed escrow call and returns the landed tx", async () => {
		const node = fakeNode();

		const landed = await operatorAt(node.transport).debit(SUB_SOLVER, DEBIT_AMOUNT, SETTLEMENT_TX);
		expect(landed).toBe(DEBIT_TX);

		const envelope = parseTransaction(node.sent.raw as Hex);
		expect(envelope.to?.toLowerCase()).toBe(ESCROW.toLowerCase());

		const call = decodeFunctionData({ abi: EscrowAbi, data: envelope.data as Hex });
		expect(call.functionName).toBe("debit");
		expect(call.args).toEqual([SUB_SOLVER, DEBIT_AMOUNT, SETTLEMENT_TX]);
	});

	it("missing receipt rejects instead of resolving", async () => {
		// Rust funnels this into DebitError::Transient so the penalty loop
		// retries; TS has no typed classification — the worker's blanket
		// catch retries any rejection, so the ported assertion is: reject,
		// never resolve with a cost.
		const node = fakeNode({ nullReceipts: true });

		await expect(operatorAt(node.transport).settlementCost(SETTLEMENT_TX)).rejects.toThrow();
	});
});
