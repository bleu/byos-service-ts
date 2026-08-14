import { EscrowAbi, TrampolineAbi } from "@byos/common";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { decodeEventLog } from "viem";

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

	/** Submits an escrow debit transaction and waits for confirmation. */
	async debit(subSolver: Address, amount: bigint, reason: Hex): Promise<Hex> {
		const hash = await this.walletClient.writeContract({
			address: this.escrowAddress,
			abi: EscrowAbi,
			functionName: "debit",
			args: [subSolver, amount, reason],
			chain: this.walletClient.chain,
			account: this.walletClient.account!,
		});

		const receipt = await this.publicClient.waitForTransactionReceipt({
			hash,
			timeout: CONFIRMATION_TIMEOUT,
		});

		if (receipt.status === "reverted") {
			throw new Error(`debit tx ${hash} reverted`);
		}

		return hash;
	}

	/** Reads the delivered delta from the Executed event in a settlement tx receipt. */
	async readExecutedDelta(txHash: Hex): Promise<bigint> {
		const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
		for (const log of receipt.logs) {
			try {
				const event = decodeEventLog({
					abi: TrampolineAbi,
					data: log.data,
					topics: log.topics,
				});
				if (event.eventName === "Executed") {
					return (event.args as { _delta: bigint })._delta;
				}
			} catch {
				// Not an Executed event from the Trampoline ABI, skip
			}
		}
		throw new Error(`No Executed event found in tx ${txHash}`);
	}
}
