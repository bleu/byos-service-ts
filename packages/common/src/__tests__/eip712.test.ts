import type { Address, Hex } from "viem";
import { createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { describe, expect, it } from "vitest";
// Load contract-generated test vectors
import vectors from "../../testdata/proposal-eip712.json" with { type: "json" };
import {
	byosDomain,
	computeInteractionsHash,
	hashProposalData,
	PROPOSAL_TYPEHASH,
	recoverCanceller,
	recoverProposer,
	recoverReader,
	signCancellation,
	signProposal,
	signReadAuth,
} from "../eip712.js";
import type { ContractInteraction, Proposal } from "../types.js";

function makeSignFn(account: ReturnType<typeof privateKeyToAccount>) {
	const client = createWalletClient({
		account,
		chain: foundry,
		transport: http(),
	});
	return (params: any) => client.signTypedData(params);
}

describe("EIP-712", () => {
	describe("type hash", () => {
		it("matches the on-chain PROPOSAL_TYPEHASH constant", () => {
			const manual = keccak256(
				new TextEncoder().encode(
					"ProposalData(bytes32 orderUidHash,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint256 quoteBuyAmount,bytes32 interactionsHash,uint256 validUntil,uint256 nonce)",
				),
			);
			expect(manual).toBe(PROPOSAL_TYPEHASH);
		});
	});

	describe("interactions hash", () => {
		it("is non-zero for empty interactions", () => {
			const hash = computeInteractionsHash([]);
			expect(hash).not.toBe(`0x${"00".repeat(32)}`);
		});

		it("is deterministic", () => {
			const interactions: ContractInteraction[] = [
				{
					target: "0x0000000000000000000000000000000000000001",
					value: 0n,
					callData: "0xabcd",
				},
			];
			const h1 = computeInteractionsHash(interactions);
			const h2 = computeInteractionsHash(interactions);
			expect(h1).toBe(h2);
		});
	});

	describe("contract test vectors", () => {
		const domain = byosDomain(vectors.domain.chainId, vectors.domain.verifyingContract as Address);

		for (const [i, vector] of vectors.vectors.entries()) {
			it(`vector ${i}: interactions hash matches`, () => {
				const interactions: ContractInteraction[] = vector.interactions.map((ix) => ({
					target: ix.target as Address,
					value: BigInt(ix.value),
					callData: ix.callData as Hex,
				}));
				const hash = computeInteractionsHash(interactions);
				expect(hash).toBe(vector.interactionsHash);
			});

			it(`vector ${i}: digest matches`, () => {
				const proposal: Proposal = {
					orderUidHash: keccak256(vector.orderUid as Hex),
					sellToken: vector.sellToken as Address,
					buyToken: vector.buyToken as Address,
					sellAmount: BigInt(vector.sellAmount),
					minBuyAmount: BigInt(vector.minBuyAmount),
					quoteBuyAmount: BigInt(vector.quoteBuyAmount),
					validUntil: BigInt(vector.validUntil),
					nonce: BigInt(vector.nonce),
				};
				expect(proposal.orderUidHash).toBe(vector.orderUidHash);

				const digest = hashProposalData(domain, proposal, vector.interactionsHash as Hex);
				expect(digest).toBe(vector.digest);
			});

			it(`vector ${i}: signature recovers sub-solver address`, async () => {
				const proposal: Proposal = {
					orderUidHash: vector.orderUidHash as Hex,
					sellToken: vector.sellToken as Address,
					buyToken: vector.buyToken as Address,
					sellAmount: BigInt(vector.sellAmount),
					minBuyAmount: BigInt(vector.minBuyAmount),
					quoteBuyAmount: BigInt(vector.quoteBuyAmount),
					validUntil: BigInt(vector.validUntil),
					nonce: BigInt(vector.nonce),
				};
				const recovered = await recoverProposer(
					vector.signature as Hex,
					domain,
					proposal,
					vector.interactionsHash as Hex,
				);
				expect(recovered.toLowerCase()).toBe(vectors.subSolver.address.toLowerCase());
			});
		}
	});

	describe("sign and recover round trips", () => {
		const account = privateKeyToAccount(
			"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
		);
		const signFn = makeSignFn(account);
		const domain = byosDomain(1, "0x00000000000000000000000000000000DeaDBeef");

		it("proposal sign/recover", async () => {
			const proposal: Proposal = {
				orderUidHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				sellToken: "0x0000000000000000000000000000000000000011",
				buyToken: "0x0000000000000000000000000000000000000022",
				sellAmount: 1_000_000n,
				minBuyAmount: 990_000n,
				quoteBuyAmount: 990_000n,
				validUntil: 1_700_000_000n,
				nonce: 42n,
			};
			const interactions: ContractInteraction[] = [
				{
					target: "0x0000000000000000000000000000000000000001",
					value: 0n,
					callData: "0x010203",
				},
			];

			const sig = await signProposal(signFn, domain, proposal, interactions);
			const interactionsHash = computeInteractionsHash(interactions);
			const recovered = await recoverProposer(sig, domain, proposal, interactionsHash);
			expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
		});

		it("cancel proposal sign/recover", async () => {
			const proposalId = 42n;
			const sig = await signCancellation(signFn, domain, proposalId);
			const recovered = await recoverCanceller(sig, domain, proposalId);
			expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
		});

		it("read auth sign/recover", async () => {
			const sig = await signReadAuth(signFn, domain);
			const recovered = await recoverReader(sig, domain);
			expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
		});

		it("wrong interactions hash recovers wrong address", async () => {
			const proposal: Proposal = {
				orderUidHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				sellToken: "0x0000000000000000000000000000000000000033",
				buyToken: "0x0000000000000000000000000000000000000044",
				sellAmount: 500_000n,
				minBuyAmount: 495_000n,
				quoteBuyAmount: 495_000n,
				validUntil: 1_700_000_000n,
				nonce: 1n,
			};
			const interactions: ContractInteraction[] = [
				{
					target: "0x0000000000000000000000000000000000000002",
					value: 0n,
					callData: "0x",
				},
			];

			const sig = await signProposal(signFn, domain, proposal, interactions);
			const wrongHash = `0x${"00".repeat(32)}` as Hex;
			const recovered = await recoverProposer(sig, domain, proposal, wrongHash);
			expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
		});
	});
});
