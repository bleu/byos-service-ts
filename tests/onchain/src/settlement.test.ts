/**
 * On-chain settlement e2e tests (mirrors crates/e2e/tests/ in the Rust repo).
 *
 * These tests spawn an Anvil instance loaded with the offline-mode state,
 * deploy the BYOS Escrow (which also deploys TrampolineFactory + Trampoline),
 * and verify that settlement calldata is accepted by the real GPv2Settlement.
 *
 * Prerequisites:
 *   - `anvil` on PATH (install via `foundryup`)
 *   - The offline-mode submodule initialised in the Rust repo, OR
 *     ANVIL_STATE_PATH env var pointing at the anvil-state.json file
 *
 * Run:
 *   pnpm vitest run --project onchain
 *
 * The tests are skipped by default because they require external
 * infrastructure. Set RUN_ONCHAIN_TESTS=1 to enable them.
 */

import { GPv2SettlementAbi } from "@byos/common";
import {
	type Address,
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	type Hex,
	http,
	keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ChainFixture,
	GPV2_AUTHENTICATOR,
	GPV2_SETTLEMENT,
	spawnChain,
	VAULT_RELAYER,
	WETH,
} from "./chain.js";

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const ENABLED = process.env.RUN_ONCHAIN_TESTS === "1";

// All tests are wrapped in describe.skipIf so they compile and show up as
// skipped in normal CI, but actually run when explicitly enabled.

// ---------------------------------------------------------------------------
// GPv2 order hashing helpers (mirrors the Rust test helpers)
// ---------------------------------------------------------------------------

const GPV2_ORDER_TYPE_HASH = keccak256(
	new TextEncoder().encode(
		"Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 " +
			"buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool " +
			"partiallyFillable,string sellTokenBalance,string buyTokenBalance)",
	),
);

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

let chain: ChainFixture;

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)("on-chain settlement", () => {
	beforeAll(async () => {
		chain = await spawnChain();
	}, 30_000);

	afterAll(() => {
		chain?.cleanup();
	});

	// -----------------------------------------------------------------------
	// 1. Chain fixture smoke test
	//    Mirrors: crates/e2e/tests/chain_fixture.rs
	// -----------------------------------------------------------------------

	describe("chain fixture", () => {
		it("deploys the Escrow at a CREATE2-derived address", async () => {
			const client = createPublicClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
			});

			const code = await client.getCode({ address: chain.escrow });
			expect(code).toBeDefined();
			expect(code).not.toBe("0x");
		});

		it("deploys the TrampolineFactory via the Escrow constructor", async () => {
			const client = createPublicClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
			});

			const code = await client.getCode({ address: chain.trampolineFactory });
			expect(code).toBeDefined();
			expect(code).not.toBe("0x");
		});

		it("Escrow reports zero balance for an unknown sub-solver", async () => {
			const client = createPublicClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
			});

			const balance = await client.readContract({
				address: chain.escrow,
				abi: [
					{
						type: "function",
						name: "effectiveBalance",
						inputs: [{ name: "_subSolver", type: "address" }],
						outputs: [{ name: "", type: "uint256" }],
						stateMutability: "view",
					},
				],
				functionName: "effectiveBalance",
				args: ["0x4242424242424242424242424242424242424242"],
			});
			expect(balance).toBe(0n);
		});

		it("anvil account 0 is whitelisted as a solver in the GPv2 Authenticator", async () => {
			const client = createPublicClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
			});

			const isSolver = await client.readContract({
				address: GPV2_AUTHENTICATOR,
				abi: [
					{
						type: "function",
						name: "isSolver",
						inputs: [{ name: "prospectiveSolver", type: "address" }],
						outputs: [{ type: "bool" }],
						stateMutability: "view",
					},
				],
				functionName: "isSolver",
				// biome-ignore lint/style/noNonNullAssertion: anvil accounts are always populated
				args: [chain.accounts[0]!],
			});
			expect(isSolver).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Partial fill settlement
	//    Mirrors: crates/e2e/tests/partial_fill.rs
	//
	//    A same-token (WETH->WETH) sell order is presigned on GPv2, then
	//    settled twice at different partial fill amounts (50%, then 30%).
	//    No trampoline -- the settlement has no interactions so GPv2's
	//    trade mechanics run in isolation.
	// -----------------------------------------------------------------------

	describe("partial fill settlement", () => {
		it("GPv2 accepts two partial fills of the same order (50% + 30%)", async () => {
			const publicClient = createPublicClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
			});

			// biome-ignore lint/style/noNonNullAssertion: anvil keys are always populated
			const userAccount = privateKeyToAccount(chain.keys[3]!);
			const walletClient = createWalletClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
				account: userAccount,
			});

			// biome-ignore lint/style/noNonNullAssertion: anvil keys are always populated
			const solverAccount = privateKeyToAccount(chain.keys[0]!);
			const solverWallet = createWalletClient({
				chain: foundry,
				transport: http(chain.rpcUrl),
				account: solverAccount,
			});

			// -- setup: wrap ETH and approve the vault relayer --

			const sellAmount = 1_000_000_000_000_000_000n; // 1 WETH
			const buyAmount = 900_000_000_000_000_000n; // 0.9 WETH limit

			// Deposit 2 WETH (headroom)
			const depositHash = await walletClient.sendTransaction({
				to: WETH,
				value: sellAmount * 2n,
				data: "0xd0e30db0" as Hex, // deposit()
			});
			await publicClient.waitForTransactionReceipt({ hash: depositHash });

			// Approve vault relayer
			const approveHash = await walletClient.sendTransaction({
				to: WETH,
				data: encodeFunctionData({
					abi: [
						{
							type: "function",
							name: "approve",
							inputs: [
								{ name: "spender", type: "address" },
								{ name: "amount", type: "uint256" },
							],
							outputs: [{ type: "bool" }],
							stateMutability: "nonpayable",
						},
					],
					functionName: "approve",
					args: [VAULT_RELAYER, 2n ** 256n - 1n],
				}),
			});
			await publicClient.waitForTransactionReceipt({ hash: approveHash });

			// -- presign the partially fillable order --

			const validTo = 0xffffffff;

			const domainSeparator = await publicClient.readContract({
				address: GPV2_SETTLEMENT,
				abi: [
					{
						type: "function",
						name: "domainSeparator",
						inputs: [],
						outputs: [{ type: "bytes32" }],
						stateMutability: "view",
					},
				],
				functionName: "domainSeparator",
			});

			// Build the GPv2 order struct hash (partially fillable sell, erc20 balances)
			const structHash = buildGpv2StructHash({
				sellToken: WETH,
				buyToken: WETH,
				receiver: "0x0000000000000000000000000000000000000000",
				sellAmount,
				buyAmount,
				validTo,
				partiallyFillable: true,
			});

			const orderDigest = eip712Digest(domainSeparator as Hex, structHash);
			const orderUid = buildOrderUid(orderDigest, userAccount.address, validTo);

			// Presign
			const presignHash = await walletClient.sendTransaction({
				to: GPV2_SETTLEMENT,
				data: encodeFunctionData({
					abi: [
						{
							type: "function",
							name: "setPreSignature",
							inputs: [
								{ name: "orderUid", type: "bytes" },
								{ name: "signed", type: "bool" },
							],
							outputs: [],
							stateMutability: "nonpayable",
						},
					],
					functionName: "setPreSignature",
					args: [orderUid, true],
				}),
			});
			await publicClient.waitForTransactionReceipt({ hash: presignHash });

			// -- first partial fill: 50% --

			const fill1 = 500_000_000_000_000_000n; // 0.5 WETH
			const settle1 = buildPartialFillSettleData({
				sellAmount,
				buyAmount,
				validTo,
				executedAmount: fill1,
				owner: userAccount.address,
			});

			const receipt1Hash = await solverWallet.sendTransaction({
				to: GPV2_SETTLEMENT,
				data: settle1,
			});
			const receipt1 = await publicClient.waitForTransactionReceipt({ hash: receipt1Hash });
			expect(receipt1.status).toBe("success");

			// -- second partial fill: 30% (cumulative 80%) --

			const fill2 = 300_000_000_000_000_000n; // 0.3 WETH
			const settle2 = buildPartialFillSettleData({
				sellAmount,
				buyAmount,
				validTo,
				executedAmount: fill2,
				owner: userAccount.address,
			});

			const receipt2Hash = await solverWallet.sendTransaction({
				to: GPV2_SETTLEMENT,
				data: settle2,
			});
			const receipt2 = await publicClient.waitForTransactionReceipt({ hash: receipt2Hash });
			expect(receipt2.status).toBe("success");
		}, 30_000);
	});

	// -----------------------------------------------------------------------
	// 3. Hooks settlement via HooksTrampoline
	//    Mirrors: crates/e2e/tests/hooks_settlement.rs
	//
	//    A fill-or-kill USDC->USDC order whose only vault-relayer allowance
	//    comes from a `permit` pre-hook. If hooks don't execute, the permit
	//    never runs and the settlement reverts for lack of approval.
	// -----------------------------------------------------------------------

	describe("hooks settlement", () => {
		it.todo(
			"settlement with permit pre-hook succeeds (proves hooks execute)",
			// Implementation requires:
			// - Deploying HooksTrampoline via CREATE2
			// - EIP-2612 permit signing for USDC allowance
			// - Building settlement calldata with pre/post interactions
			// The HooksTrampoline artifact with bytecode is available at
			// tests/onchain/artifacts/HooksTrampoline.json
		);
	});

	// -----------------------------------------------------------------------
	// 4. Partial fills with hooks
	//    Mirrors: crates/e2e/tests/partial_fill_hooks.rs
	//
	//    Combines partial fills and hooks: a partially fillable USDC->USDC
	//    order is settled in two rounds. First fill (50%) includes pre+post
	//    hooks; second fill (30%) includes only post-hook -- matching the
	//    CoW social consensus that pre-hooks run only on the first fill.
	// -----------------------------------------------------------------------

	describe("partial fills with hooks", () => {
		it.todo(
			"first fill (50%) with pre-hook permit + post-hook succeeds",
			// Same prerequisites as hooks settlement above, plus partial fill encoding
		);

		it.todo(
			"second fill (30%) with only post-hook succeeds (remaining allowance covers it)",
			// Depends on the first fill having run the permit pre-hook
		);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the GPv2 EIP-712 struct hash for an order. */
function buildGpv2StructHash(params: {
	sellToken: Address;
	buyToken: Address;
	receiver: Address;
	sellAmount: bigint;
	buyAmount: bigint;
	validTo: number;
	partiallyFillable: boolean;
}): Hex {
	const padAddr = (a: Address): Hex => `0x${a.slice(2).padStart(64, "0")}` as Hex;
	const padUint = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

	const parts = [
		GPV2_ORDER_TYPE_HASH,
		padAddr(params.sellToken),
		padAddr(params.buyToken),
		padAddr(params.receiver),
		padUint(params.sellAmount),
		padUint(params.buyAmount),
		padUint(BigInt(params.validTo)),
		`0x${"00".repeat(32)}` as Hex, // appData
		padUint(0n), // feeAmount
		keccak256(new TextEncoder().encode("sell")),
		padUint(params.partiallyFillable ? 1n : 0n),
		keccak256(new TextEncoder().encode("erc20")),
		keccak256(new TextEncoder().encode("erc20")),
	] as Hex[];

	return keccak256(`0x${parts.map((p) => p.slice(2)).join("")}` as Hex);
}

/** Compute `keccak256("\x19\x01" || domainSeparator || structHash)`. */
function eip712Digest(domainSeparator: Hex, structHash: Hex): Hex {
	return keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);
}

/** Build a 56-byte GPv2 order UID: `orderDigest ++ owner ++ validTo`. */
function buildOrderUid(digest: Hex, owner: Address, validTo: number): Hex {
	const validToHex = validTo.toString(16).padStart(8, "0");
	return (digest + owner.slice(2).toLowerCase() + validToHex) as Hex;
}

/** Build `settle()` calldata for a partial fill of a same-token presigned
 *  sell order with no interactions. */
function buildPartialFillSettleData(params: {
	sellAmount: bigint;
	buyAmount: bigint;
	validTo: number;
	executedAmount: bigint;
	owner: Address;
}): Hex {
	// Flags: sell (bit 0 = 0), partially fillable (bit 1),
	// erc20 balances (bits 2-4 = 0), presign (bits 5-6 = 0b11)
	const flags = 2n | (3n << 5n);

	return encodeFunctionData({
		abi: GPv2SettlementAbi,
		functionName: "settle",
		args: [
			[WETH, WETH], // tokens
			[params.executedAmount, params.executedAmount], // clearingPrices (1:1 same token)
			[
				{
					sellTokenIndex: 0n,
					buyTokenIndex: 1n,
					receiver: "0x0000000000000000000000000000000000000000" as Address,
					sellAmount: params.sellAmount,
					buyAmount: params.buyAmount,
					validTo: params.validTo,
					appData: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
					feeAmount: 0n,
					flags,
					executedAmount: params.executedAmount,
					// Presign signature = 20-byte owner address
					signature: params.owner as Hex,
				},
			],
			[[], [], []], // interactions: [pre, intra, post] -- all empty
		],
	});
}
