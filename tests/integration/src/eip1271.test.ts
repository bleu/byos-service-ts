import { computeInteractionsHash, hashProposalData, Kind } from "@byos/common";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createTestApp,
	DOMAIN,
	SIGN_FN,
	SIGNER_ACCOUNT,
	stubAuctionForOrder,
	type TestApp,
} from "./helpers.js";

// A nonce counter isolated to this file so parallel test files don't collide.
let nonce = 10_000n;

const ORDER_UID = `0x${"cd".repeat(56)}` as Hex;
const SELL_TOKEN: Address = "0x1111111111111111111111111111111111111111";
const BUY_TOKEN: Address = "0x2222222222222222222222222222222222222222";
const SELL_AMOUNT = 1_000_000n;
const MIN_BUY_AMOUNT = 990_000n;
const QUOTE_BUY_AMOUNT = 990_000n;
const INTERACTIONS = [
	{
		target: "0x00000000000000000000000000000000000000dd" as Address,
		value: 0n,
		callData: "0xdead" as Hex,
	},
];

/** Builds a POST /proposals body. `signature` and `subSolverAddress` are
 * caller-supplied so each test can vary them independently. */
function makeBody(signature: Hex, subSolverAddress?: Address) {
	const validUntil = BigInt(Math.floor(Date.now() / 1000)) + 300n;
	const n = nonce++;
	return {
		orderUid: ORDER_UID,
		sellToken: SELL_TOKEN,
		buyToken: BUY_TOKEN,
		sellAmount: SELL_AMOUNT.toString(),
		minBuyAmount: MIN_BUY_AMOUNT.toString(),
		quoteBuyAmount: QUOTE_BUY_AMOUNT.toString(),
		interactions: INTERACTIONS.map((i) => ({
			target: i.target,
			value: i.value.toString(),
			callData: i.callData,
		})),
		validUntil: validUntil.toString(),
		nonce: n.toString(),
		signature,
		...(subSolverAddress !== undefined ? { subSolverAddress } : {}),
	};
}

/** Computes the EIP-712 digest for a given body so mock verifiers can check it. */
function digestForBody(body: ReturnType<typeof makeBody>): Hex {
	const interactions = INTERACTIONS;
	const interactionsHash = computeInteractionsHash(interactions);
	return hashProposalData(
		DOMAIN,
		{
			orderUidHash: keccak256(ORDER_UID),
			sellToken: SELL_TOKEN,
			buyToken: BUY_TOKEN,
			sellAmount: SELL_AMOUNT,
			minBuyAmount: MIN_BUY_AMOUNT,
			quoteBuyAmount: QUOTE_BUY_AMOUNT,
			validUntil: BigInt(body.validUntil),
			nonce: BigInt(body.nonce),
		},
		interactionsHash,
	);
}

// --- Tests ---

describe("EIP-1271 contract sub-solvers", () => {
	describe("EOA declaring subSolverAddress (ECDSA fast path)", () => {
		let app: TestApp;

		beforeAll(async () => {
			app = await createTestApp();
			stubAuctionForOrder(ORDER_UID);
		});

		afterAll(async () => {
			await app.ctx.cleanup();
		});

		it("accepts a proposal when declared subSolverAddress matches ECDSA recovery", async () => {
			// Sign with the EOA key; provide its address explicitly.
			const { signProposal } = await import("@byos/common");
			const validUntil = BigInt(Math.floor(Date.now() / 1000)) + 300n;
			const n = nonce++;
			const _interactionsHash = computeInteractionsHash(INTERACTIONS);
			const proposal = {
				orderUidHash: keccak256(ORDER_UID),
				sellToken: SELL_TOKEN,
				buyToken: BUY_TOKEN,
				sellAmount: SELL_AMOUNT,
				minBuyAmount: MIN_BUY_AMOUNT,
				quoteBuyAmount: QUOTE_BUY_AMOUNT,
				validUntil,
				nonce: n,
			};
			const sig = await signProposal(SIGN_FN, DOMAIN, proposal, INTERACTIONS);

			const resp = await app.publicApp.request("/proposals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					orderUid: ORDER_UID,
					sellToken: SELL_TOKEN,
					buyToken: BUY_TOKEN,
					sellAmount: SELL_AMOUNT.toString(),
					minBuyAmount: MIN_BUY_AMOUNT.toString(),
					quoteBuyAmount: QUOTE_BUY_AMOUNT.toString(),
					interactions: INTERACTIONS.map((i) => ({
						target: i.target,
						value: i.value.toString(),
						callData: i.callData,
					})),
					validUntil: validUntil.toString(),
					nonce: n.toString(),
					signature: sig,
					// Explicitly declare the EOA address — should match ECDSA without RPC.
					subSolverAddress: SIGNER_ACCOUNT.address,
				}),
			});
			expect(resp.status).toBe(202);
			const body = await resp.json();
			expect(typeof body.id).toBe("number");
		});
	});

	describe("contract sub-solver with verifyEip1271 configured", () => {
		const CONTRACT_ADDRESS: Address = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
		// A signature that is not a valid 65-byte ECDSA sig (mimics a contract signature).
		const CONTRACT_SIG: Hex = `0x${"aa".repeat(100)}`; // 100 bytes

		let app: TestApp;
		let mockVerifier: ReturnType<typeof vi.fn>;

		beforeAll(async () => {
			mockVerifier = vi.fn();
			app = await createTestApp({ verifyEip1271: mockVerifier });
			stubAuctionForOrder(ORDER_UID);
		});

		afterAll(async () => {
			await app.ctx.cleanup();
		});

		it("accepts a proposal when verifyEip1271 returns true", async () => {
			mockVerifier.mockResolvedValueOnce(true);
			const body = makeBody(CONTRACT_SIG, CONTRACT_ADDRESS);
			const resp = await app.publicApp.request("/proposals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(resp.status).toBe(202);
			expect(mockVerifier).toHaveBeenCalledWith(
				CONTRACT_ADDRESS.toLowerCase(),
				digestForBody(body),
				CONTRACT_SIG,
			);
		});

		it("rejects with SignatureRecoveryFailed when verifyEip1271 returns false", async () => {
			mockVerifier.mockResolvedValueOnce(false);
			const body = makeBody(CONTRACT_SIG, CONTRACT_ADDRESS);
			const resp = await app.publicApp.request("/proposals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(resp.status).toBe(400);
			const json = await resp.json();
			expect(json.kind).toBe(Kind.SignatureRecoveryFailed);
		});

		it("rejects with SignatureRecoveryFailed when verifyEip1271 throws", async () => {
			mockVerifier.mockRejectedValueOnce(new Error("RPC timeout"));
			const body = makeBody(CONTRACT_SIG, CONTRACT_ADDRESS);
			const resp = await app.publicApp.request("/proposals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(resp.status).toBe(400);
			const json = await resp.json();
			expect(json.kind).toBe(Kind.SignatureRecoveryFailed);
		});
	});

	describe("contract sub-solver without verifyEip1271 configured", () => {
		const CONTRACT_ADDRESS: Address = "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";
		const CONTRACT_SIG: Hex = `0x${"bb".repeat(100)}`;

		let app: TestApp;

		beforeAll(async () => {
			// No verifyEip1271 — simulates a deployment that hasn't wired EIP-1271.
			app = await createTestApp();
		});

		afterAll(async () => {
			await app.ctx.cleanup();
		});

		it("returns 503 Eip1271NotAvailable when subSolverAddress is set but verifier is absent", async () => {
			const body = makeBody(CONTRACT_SIG, CONTRACT_ADDRESS);
			const resp = await app.publicApp.request("/proposals", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(resp.status).toBe(503);
			const json = await resp.json();
			expect(json.kind).toBe(Kind.Eip1271NotAvailable);
		});
	});
});
