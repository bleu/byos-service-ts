import type { Address, Hex } from "viem";
import { decodeFunctionData, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";

import { TrampolineAbi } from "../abis/trampoline.js";
import { encodeTrampolineInteractions } from "../trampoline.js";
import type { ContractInteraction, Proposal } from "../types.js";

function sampleProposal(): Proposal {
	return {
		orderUidHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		validUntil: 1_700_000_000n,
		nonce: 1n,
	};
}

function sampleInteractions(): ContractInteraction[] {
	return [
		{
			target: "0x0000000000000000000000000000000000000042",
			value: 0n,
			callData: "0xabcdef",
		},
	];
}

const trampoline: Address = "0x0000000000000000000000000000000000001234";
const sellToken: Address = "0x0000000000000000000000000000000000005678";
const buyToken: Address = "0x0000000000000000000000000000000000009abc";
const signature: Hex = `0x${"00".repeat(65)}`;

describe("trampoline encoding", () => {
	it("transfer calldata has correct selector (0xa9059cbb)", () => {
		const [transfer] = encodeTrampolineInteractions(
			trampoline,
			sellToken,
			sampleProposal(),
			sampleInteractions(),
			buyToken,
			signature,
		);

		expect(transfer.target.toLowerCase()).toBe(sellToken.toLowerCase());
		expect(transfer.value).toBe(0n);
		expect(transfer.callData.slice(0, 10)).toBe("0xa9059cbb");
	});

	it("execute calldata has correct selector", () => {
		const [, execute] = encodeTrampolineInteractions(
			trampoline,
			sellToken,
			sampleProposal(),
			sampleInteractions(),
			buyToken,
			signature,
		);

		expect(execute.target.toLowerCase()).toBe(trampoline.toLowerCase());
		expect(execute.value).toBe(0n);

		// Verify selector matches keccak256 of the function signature
		const expectedSelector = keccak256(
			toHex(
				"execute((bytes32,uint256,uint256,uint256,uint256,uint256),(address,uint256,bytes)[],address,bytes)",
			),
		).slice(0, 10);
		expect(execute.callData.slice(0, 10)).toBe(expectedSelector);
	});

	it("execute calldata round-trips through ABI decode", () => {
		const proposal = sampleProposal();
		const interactions = sampleInteractions();
		const sig: Hex = `0x${"01".repeat(65)}`;

		const [, execute] = encodeTrampolineInteractions(
			trampoline,
			sellToken,
			proposal,
			interactions,
			buyToken,
			sig,
		);

		const decoded = decodeFunctionData({
			abi: TrampolineAbi,
			data: execute.callData,
		});

		expect(decoded.functionName).toBe("execute");
		const [decodedProposal, decodedInteractions, decodedBuyToken, decodedSig] = decoded.args;

		expect(decodedProposal.orderUidHash).toBe(proposal.orderUidHash);
		expect(decodedProposal.sellAmount).toBe(proposal.sellAmount);
		expect(decodedProposal.minBuyAmount).toBe(proposal.minBuyAmount);
		expect(decodedProposal.quoteBuyAmount).toBe(proposal.quoteBuyAmount);
		expect(decodedProposal.validUntil).toBe(proposal.validUntil);
		expect(decodedProposal.nonce).toBe(proposal.nonce);
		expect(decodedInteractions).toHaveLength(1);
		expect(decodedInteractions[0]?.target.toLowerCase()).toBe(
			interactions[0]?.target.toLowerCase(),
		);
		expect(decodedBuyToken.toLowerCase()).toBe(buyToken.toLowerCase());
		expect(decodedSig).toBeDefined();
		expect(decodedSig!.toLowerCase()).toBe(sig.toLowerCase());
	});

	it("encodes with empty interactions", () => {
		const [, execute] = encodeTrampolineInteractions(
			trampoline,
			sellToken,
			sampleProposal(),
			[],
			buyToken,
			signature,
		);

		const decoded = decodeFunctionData({
			abi: TrampolineAbi,
			data: execute.callData,
		});
		const [, decodedInteractions] = decoded.args;
		expect(decodedInteractions).toHaveLength(0);
	});
});
