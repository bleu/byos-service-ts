import { EscrowAbi, TrampolineAbi } from "@byos/common";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { decodeEventLog, encodeFunctionData, keccak256 } from "viem";

const CONFIRMATION_TIMEOUT = 120_000; // 120 seconds

export class EscrowOperator {
	constructor(
		private readonly walletClient: WalletClient,
		private readonly publicClient: PublicClient,
		private readonly escrowAddress: Address,
	) {}

	/** Fetches the on-chain cost of a settlement transaction (gasUsed × effectiveGasPrice). */
	async settlementCost(txHash: Hex): Promise<bigint> {
		const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
		return receipt.gasUsed * receipt.effectiveGasPrice;
	}

	/** Compatibility wrapper for callers not yet migrated to durable operations. */
	async debit(subSolver: Address, amount: bigint, reason: Hex): Promise<Hex> {
		const signed = await this.signDebit(subSolver, amount, reason);
		const hash = await this.broadcastSignedDebit(signed.rawTransaction);
		const receipt = await this.publicClient.waitForTransactionReceipt({
			hash,
			timeout: CONFIRMATION_TIMEOUT,
		});
		if (receipt.status === "reverted") throw new Error(`debit tx ${hash} reverted`);
		return hash;
	}

	/** Produces stable bytes which callers must persist before broadcasting. */
	async signDebit(
		subSolver: Address,
		amount: bigint,
		reason: Hex,
	): Promise<{ rawTransaction: Hex; hash: Hex }> {
		const account = this.walletClient.account;
		if (!account?.signTransaction) throw new Error("escrow operator cannot sign transactions");
		const data = encodeFunctionData({
			abi: EscrowAbi,
			functionName: "debit",
			args: [subSolver, amount, reason],
		});
		const request = await this.walletClient.prepareTransactionRequest({
			account,
			chain: this.walletClient.chain,
			to: this.escrowAddress,
			data,
		});
		const { account: _requestAccount, chain: _requestChain, ...transaction } = request;
		const rawTransaction = await account.signTransaction(
			transaction as Parameters<typeof account.signTransaction>[0],
		);
		return { rawTransaction, hash: keccak256(rawTransaction) };
	}

	async broadcastSignedDebit(rawTransaction: Hex): Promise<Hex> {
		return this.publicClient.sendRawTransaction({ serializedTransaction: rawTransaction });
	}

	async debitOutcome(hash: Hex): Promise<"succeeded" | "reverted" | null> {
		try {
			const receipt = await this.publicClient.getTransactionReceipt({ hash });
			return receipt.status === "success" ? "succeeded" : "reverted";
		} catch {
			return null;
		}
	}

	/** Reads the delivered delta from the Executed event in a settlement tx receipt. */
	async readExecutedDelta(txHash: Hex, orderUidHash: Hex): Promise<bigint> {
		const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
		for (const log of receipt.logs) {
			try {
				const event = decodeEventLog({
					abi: TrampolineAbi,
					data: log.data,
					topics: log.topics,
				});
				if (
					event.eventName === "Executed" &&
					(event.args as { _orderUidHash: Hex })._orderUidHash === orderUidHash
				) {
					return (event.args as { _delta: bigint })._delta;
				}
			} catch {
				// Not an Executed event from the Trampoline ABI, skip
			}
		}
		throw new Error(`No Executed event for ${orderUidHash} found in tx ${txHash}`);
	}
}
