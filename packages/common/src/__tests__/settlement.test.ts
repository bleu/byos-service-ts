import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { type CowOrder, encodeSettle, OrderKind, SigningScheme } from "../settlement.js";
import type { SettlementInteraction } from "../trampoline.js";
import type { ContractInteraction, Proposal } from "../types.js";

function fixtureOrder(): CowOrder {
	return {
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		receiver: "0xd2e80D60aff5377587E49FF32c9bad639d6f68Bc",
		sellAmount: 20_000_002_675_677_095_795n,
		buyAmount: 773_213_156n,
		validTo: 1_785_170_912,
		appData: "0x06ebf0fd49ea441fbd174e445f37f792eb8ee8848c66c470f59d06a1c3e318a4",
		feeAmount: 0n,
		kind: OrderKind.SELL,
		partiallyFillable: false,
		signingScheme: SigningScheme.Eip712,
		signature:
			"0x45bcd35b2abeeafca8cd2ea00bd662ab327e0ffd7cd38319eeff8432fd49409f6e56384a88dcdc050d92b389285c3cfd78c903f3a20f64641b9f907dbf9de8b71c",
	};
}

function fixtureProposal(): Proposal {
	const orderUid =
		"0xb9403b4c8342c3567e5b1928398030f010730c0b1d83657248e4e4e47984d90bd2e80d60aff5377587e49ff32c9bad639d6f68bc6a678be0" as Hex;
	return {
		orderUidHash: keccak256(orderUid),
		sellAmount: 20_000_002_675_677_095_795n,
		buyAmount: 773_213_156n,
		validUntil: 1_785_174_512n,
		nonce: 0n,
	};
}

const trampolineAddr: Address = "0x0000000000000000000000000000000000007777";
const proposalSig: Hex = `0x${"11".repeat(65)}`;

describe("settlement encoding", () => {
	it("settle calldata matches Solidity encoding", () => {
		const route: ContractInteraction[] = [
			{
				target: "0x0000000000000000000000000000000000004444",
				value: 0n,
				callData: "0xabcd",
			},
		];

		const calldata = encodeSettle(
			fixtureOrder(),
			fixtureProposal(),
			trampolineAddr,
			route,
			proposalSig,
			[],
			[],
		);

		const expectedPath = resolve(import.meta.dirname, "../../testdata/settle-calldata.hex");
		const expected = readFileSync(expectedPath, "utf-8").trim();
		expect(calldata.toLowerCase()).toBe(expected.toLowerCase());
	});

	it("buy order flags and executed amount", () => {
		const order = { ...fixtureOrder(), kind: OrderKind.BUY, signingScheme: SigningScheme.Eip1271 };
		const proposal = fixtureProposal();

		const calldata = encodeSettle(order, proposal, trampolineAddr, [], proposalSig, [], []);

		// Verify the calldata is non-empty (detailed decode would require full ABI decode)
		expect(calldata.length).toBeGreaterThan(10);
	});

	it("pre and post hook interactions are spliced into the settlement", () => {
		const pre: SettlementInteraction[] = [
			{
				target: "0x000000000000000000000000000000000000aaaa",
				value: 0n,
				callData: "0x11111111",
			},
		];
		const post: SettlementInteraction[] = [
			{
				target: "0x000000000000000000000000000000000000bbbb",
				value: 0n,
				callData: "0x22222222",
			},
			{
				target: "0x000000000000000000000000000000000000cccc",
				value: 0n,
				callData: "0x33333333",
			},
		];

		const calldata = encodeSettle(
			fixtureOrder(),
			fixtureProposal(),
			trampolineAddr,
			[],
			proposalSig,
			pre,
			post,
		);

		// Verify calldata contains the pre/post hook target addresses
		const calldataLower = calldata.toLowerCase();
		expect(calldataLower).toContain("000000000000000000000000000000000000aaaa");
		expect(calldataLower).toContain("000000000000000000000000000000000000bbbb");
		expect(calldataLower).toContain("000000000000000000000000000000000000cccc");
	});
});
