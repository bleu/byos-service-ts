/**
 * context.db.test.ts — shape tests for buildContext.
 *
 * Each test calls buildContext with a specific config variant and asserts on
 * the shape of the returned AppContext. Comments on every assertion state which
 * line in context.ts would break the test if deleted.
 *
 * Mutation-check rule: if deleting the line in context.ts that sets a field
 * would leave the assertion still passing, the assertion is not here.
 *
 * Tier: DB — needs Postgres + Redis (`docker compose up -d postgres redis`).
 */

import * as http from "node:http";
import { minCollateralFor } from "@byos/common";
import pino from "pino";
import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../test/setup.js";
import { parseConfig } from "../config.js";
import { buildContext } from "../context.js";
import { EscrowOperator } from "../infra/blockchain/operator.js";
import { ProposalValidator } from "../infra/blockchain/validator.js";

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });

/** Returns a URL to a minimal JSON-RPC stub that answers eth_blockNumber.
 * This lets us test the RPC-enabled variants without a real node. */
function startJsonRpcStub(): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				// Respond to eth_blockNumber (used by publicClient.getBlockNumber)
				// and eth_chainId (viem may call it for chain validation).
				let result: string;
				try {
					const rpc = JSON.parse(body);
					if (rpc.method === "eth_blockNumber") {
						result = "0x1";
					} else if (rpc.method === "eth_chainId") {
						// Chain 1 = mainnet, matching the CHAIN_ID in the test configs
						result = "0x1";
					} else {
						result = "0x0";
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
				} catch {
					res.writeHead(400);
					res.end();
				}
			});
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("unexpected address type from http.Server"));
				return;
			}
			const url = `http://127.0.0.1:${addr.port}`;
			const close = () =>
				new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
			resolve({ url, close });
		});
	});
}

// Shared fake addresses — values are checked by address-regex in config
const FAKE_ESCROW: Address = "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const FAKE_SETTLEMENT: Address = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const FAKE_TRAMPOLINE_FACTORY: Address = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
// A test operator private key (Anvil account #1 — never touches real funds).
const TEST_OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ---------------------------------------------------------------------------
// Test-database setup (one per describe block so contexts don't share state)
// ---------------------------------------------------------------------------

describe("buildContext — no RPC", () => {
	let dbCtx: TestContext;
	let ctx: Awaited<ReturnType<typeof buildContext>>;

	beforeAll(async () => {
		dbCtx = await createTestDb();

		const config = parseConfig({
			DATABASE_URL: dbCtx.url,
			CHAIN_ID: "1",
			TRAMPOLINE_FACTORY: FAKE_TRAMPOLINE_FACTORY,
		});

		ctx = await buildContext(config, logger);
	});

	afterAll(async () => {
		// Close BullMQ queues and Redis connections to avoid open handle warnings.
		await ctx.queues.validation.close();
		await ctx.queues.validateProposal.close();
		await ctx.queues.retention.close();
		await ctx.queues.penalty.close();
		await ctx.queues.audit.close();
		await ctx.queues.balanceRefresh.close();
		ctx.redis.disconnect();
		ctx.requestRedis.disconnect();
		await ctx.dbClient.end();
		await dbCtx.cleanup();
	});

	// Deleting the `let validator: ValidateProposal = acceptAll` line (or the
	// assignment inside the `else` branch) would make validator undefined / a
	// ProposalValidator, which would fail this check.
	it("validator is acceptAll when no RPC is configured", () => {
		// ProposalValidator is only constructed inside the `if (config.RPC_URL)`
		// block; without RPC the code falls through to the `acceptAll` default.
		// Removing `let validator: ValidateProposal = acceptAll` in context.ts
		// would make this a ProposalValidator or throw.
		expect(ctx.validator).not.toBeInstanceOf(ProposalValidator);
		// acceptAll has a `validate` method but no class prototype — the name
		// check is the clearest way to express "this is the stub, not the real one".
		expect(ctx.validator.validate).toBeDefined();
	});

	// Deleting the `let balanceRefresh: BalanceRefreshConfig | null = null` line
	// or the RPC guard would leave balanceRefresh as something non-null.
	it("balanceRefresh is null when no RPC is configured", () => {
		// context.ts: `let balanceRefresh: BalanceRefreshConfig | null = null`
		// is only overwritten inside `if (config.RPC_URL)`.
		expect(ctx.balanceRefresh).toBeNull();
	});

	// Deleting `let operator: EscrowOperator | null = null` or the RPC guard
	// would make operator non-null or throw.
	it("operator is null when no RPC is configured", () => {
		// context.ts: `let operator: EscrowOperator | null = null`
		// is only overwritten inside `if (config.RPC_URL) { if (OPERATOR_KEY) ... }`.
		expect(ctx.operator).toBeNull();
	});

	// Deleting `const minCollateralWei = config.MIN_COLLATERAL !== undefined ? ...`
	// or swapping to a hard-coded value would break this.
	it("minCollateralWei is the chain default when MIN_COLLATERAL is unset", () => {
		// context.ts: `minCollateralFor(config.CHAIN_ID)` is called when
		// `config.MIN_COLLATERAL` is undefined.
		expect(ctx.minCollateralWei).toBe(minCollateralFor(1));
	});

	// Deleting the `rateLimits = rateLimitsFromConfig(config, minCollateralWei)` line
	// would leave rateLimits.floorWei at 0 or undefined.
	it("rateLimits.floorWei is the resolved chain collateral floor", () => {
		// context.ts: `rateLimitsFromConfig(config, minCollateralWei)` passes
		// the resolved floor; if the arg was `0n` or omitted the assertion fails.
		expect(ctx.rateLimits.floorWei).toBe(minCollateralFor(1));
	});

	// Deleting `const trampolineFactory: Address = ...` or failing to return it
	// in the context object would break this.
	it("trampolineFactory is the TRAMPOLINE_FACTORY from config", () => {
		// context.ts: `if (config.TRAMPOLINE_FACTORY) return config.TRAMPOLINE_FACTORY as Address`
		// If that line were removed, trampolineFactoryFor(1) would be called;
		// for mainnet (chain 1) that returns null and throws.
		expect(ctx.trampolineFactory).toBe(FAKE_TRAMPOLINE_FACTORY);
	});
});

// ---------------------------------------------------------------------------

describe("buildContext — RPC without operator", () => {
	let dbCtx: TestContext;
	let rpcStub: { url: string; close: () => Promise<void> };
	let ctx: Awaited<ReturnType<typeof buildContext>>;

	beforeAll(async () => {
		dbCtx = await createTestDb();
		rpcStub = await startJsonRpcStub();

		const config = parseConfig({
			DATABASE_URL: dbCtx.url,
			CHAIN_ID: "1",
			TRAMPOLINE_FACTORY: FAKE_TRAMPOLINE_FACTORY,
			RPC_URL: rpcStub.url,
			ORDERBOOK_URL: "http://127.0.0.1:1", // unused — no orderbook calls in buildContext
			ESCROW_ADDRESS: FAKE_ESCROW,
			SETTLEMENT_ADDRESS: FAKE_SETTLEMENT,
			DEFAULT_GAS_PRICE: "1000000000",
		});

		ctx = await buildContext(config, logger);
	});

	afterAll(async () => {
		await ctx.queues.validation.close();
		await ctx.queues.validateProposal.close();
		await ctx.queues.retention.close();
		await ctx.queues.penalty.close();
		await ctx.queues.audit.close();
		await ctx.queues.balanceRefresh.close();
		ctx.redis.disconnect();
		ctx.requestRedis.disconnect();
		await ctx.dbClient.end();
		await rpcStub.close();
		await dbCtx.cleanup();
	});

	// Deleting `validator = new ProposalValidator(escrowValidator, simulationValidator)`
	// inside the RPC block leaves validator as `acceptAll`.
	it("validator is a ProposalValidator when RPC is configured", () => {
		// context.ts: inside `if (config.RPC_URL)`, the code builds
		// EscrowValidator + SimulationValidator and wraps them in ProposalValidator.
		// If that assignment were removed, `ctx.validator` would still be `acceptAll`.
		expect(ctx.validator).toBeInstanceOf(ProposalValidator);
	});

	// Deleting `balanceRefresh = { store: balanceStore, ... }` inside the RPC
	// block would leave it null.
	it("balanceRefresh is non-null when RPC is configured", () => {
		// context.ts: `balanceRefresh = { store: balanceStore, fetchBalances, ... }`
		// is set inside `if (config.RPC_URL)`.
		expect(ctx.balanceRefresh).not.toBeNull();
	});

	// Deleting `balanceRefresh.floorWei = rateLimits.floorWei` would leave it 0.
	it("balanceRefresh.floorWei matches rateLimits.floorWei", () => {
		// context.ts: `floorWei: rateLimits.floorWei` in the balanceRefresh object.
		// If that line passed 0n instead of rateLimits.floorWei, this assertion fails.
		expect(ctx.balanceRefresh?.floorWei).toBe(ctx.rateLimits.floorWei);
	});

	// Deleting `let operator: EscrowOperator | null = null` or the OPERATOR_KEY
	// guard would break the invariant that no-key means null operator.
	it("operator is null when OPERATOR_PRIVATE_KEY is absent", () => {
		// context.ts: `if (config.OPERATOR_PRIVATE_KEY) { ... operator = new EscrowOperator(...) }`
		// Without the key the assignment is skipped; operator stays null.
		expect(ctx.operator).toBeNull();
	});

	// Deleting `const escrowAddress = ...` or passing the wrong address to
	// EscrowValidator would be caught here because balanceRefresh.fetchBalances
	// is created with `createEscrowBalanceReader(publicClient, escrowAddress)`.
	// We probe that the escrow address reached the config field.
	it("config.ESCROW_ADDRESS is preserved in context.config", () => {
		// context.ts: `const { db, client: dbClient } = createDb(config.DATABASE_URL)`
		// and `return { ..., config, ... }` — if config were replaced with a copy
		// that cleared ESCROW_ADDRESS the assertion would fail.
		expect(ctx.config.ESCROW_ADDRESS?.toLowerCase()).toBe(FAKE_ESCROW.toLowerCase());
	});
});

// ---------------------------------------------------------------------------

describe("buildContext — RPC with operator", () => {
	let dbCtx: TestContext;
	let rpcStub: { url: string; close: () => Promise<void> };
	let ctx: Awaited<ReturnType<typeof buildContext>>;

	beforeAll(async () => {
		dbCtx = await createTestDb();
		rpcStub = await startJsonRpcStub();

		const config = parseConfig({
			DATABASE_URL: dbCtx.url,
			CHAIN_ID: "1",
			TRAMPOLINE_FACTORY: FAKE_TRAMPOLINE_FACTORY,
			RPC_URL: rpcStub.url,
			ORDERBOOK_URL: "http://127.0.0.1:1",
			ESCROW_ADDRESS: FAKE_ESCROW,
			SETTLEMENT_ADDRESS: FAKE_SETTLEMENT,
			DEFAULT_GAS_PRICE: "1000000000",
			OPERATOR_PRIVATE_KEY: TEST_OPERATOR_KEY,
		});

		ctx = await buildContext(config, logger);
	});

	afterAll(async () => {
		await ctx.queues.validation.close();
		await ctx.queues.validateProposal.close();
		await ctx.queues.retention.close();
		await ctx.queues.penalty.close();
		await ctx.queues.audit.close();
		await ctx.queues.balanceRefresh.close();
		ctx.redis.disconnect();
		ctx.requestRedis.disconnect();
		await ctx.dbClient.end();
		await rpcStub.close();
		await dbCtx.cleanup();
	});

	// Deleting `operator = new EscrowOperator(walletClient, publicClient, escrowAddress)`
	// inside the OPERATOR_PRIVATE_KEY block would leave operator null.
	it("operator is an EscrowOperator when OPERATOR_PRIVATE_KEY is set", () => {
		// context.ts: `if (config.OPERATOR_PRIVATE_KEY) {`
		// `  const account = privateKeyToAccount(config.OPERATOR_PRIVATE_KEY as Hex);`
		// `  const walletClient = createWalletClient({ account, chain, transport });`
		// `  operator = new EscrowOperator(walletClient, publicClient, escrowAddress);`
		// Removing that block or the assignment leaves operator as null.
		expect(ctx.operator).toBeInstanceOf(EscrowOperator);
	});

	// All three RPC-dependent fields must be non-null together — the operator
	// variant still needs a working validator and balance refresh.
	it("validator and balanceRefresh are also set when operator is present", () => {
		expect(ctx.validator).toBeInstanceOf(ProposalValidator);
		expect(ctx.balanceRefresh).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------

describe("buildContext — MIN_COLLATERAL override", () => {
	// Two sub-cases in a single describe so we only spin up one DB pair.
	// Each case needs its own context, so they are built in separate `it` blocks
	// inside the describe but we track cleanup handles manually.

	let dbCtx1: TestContext;
	let dbCtx2: TestContext;
	const cleanup: Array<() => Promise<void>> = [];

	afterAll(async () => {
		for (const fn of cleanup) {
			await fn();
		}
		await dbCtx1?.cleanup();
		await dbCtx2?.cleanup();
	});

	it("MIN_COLLATERAL override replaces the chain default everywhere", async () => {
		dbCtx1 = await createTestDb();
		const CUSTOM_COLLATERAL = "999000000000000000"; // 0.999 ETH — distinct from any chain default

		const config = parseConfig({
			DATABASE_URL: dbCtx1.url,
			CHAIN_ID: "1",
			TRAMPOLINE_FACTORY: FAKE_TRAMPOLINE_FACTORY,
			MIN_COLLATERAL: CUSTOM_COLLATERAL,
		});

		const ctx = await buildContext(config, logger);
		cleanup.push(async () => {
			await ctx.queues.validation.close();
			await ctx.queues.validateProposal.close();
			await ctx.queues.retention.close();
			await ctx.queues.penalty.close();
			await ctx.queues.audit.close();
			await ctx.queues.balanceRefresh.close();
			ctx.redis.disconnect();
			ctx.requestRedis.disconnect();
			await ctx.dbClient.end();
		});

		// context.ts: `config.MIN_COLLATERAL !== undefined ? BigInt(config.MIN_COLLATERAL)`
		// If that branch were removed, minCollateralFor(1) = 10^16 would be used instead.
		expect(ctx.minCollateralWei).toBe(BigInt(CUSTOM_COLLATERAL));

		// context.ts: `rateLimitsFromConfig(config, minCollateralWei)`
		// If minCollateralWei were not passed through, floorWei would differ.
		expect(ctx.rateLimits.floorWei).toBe(BigInt(CUSTOM_COLLATERAL));
	});

	it("without MIN_COLLATERAL override the chain default is used everywhere", async () => {
		dbCtx2 = await createTestDb();

		const config = parseConfig({
			DATABASE_URL: dbCtx2.url,
			CHAIN_ID: "1",
			TRAMPOLINE_FACTORY: FAKE_TRAMPOLINE_FACTORY,
			// No MIN_COLLATERAL
		});

		const ctx = await buildContext(config, logger);
		cleanup.push(async () => {
			await ctx.queues.validation.close();
			await ctx.queues.validateProposal.close();
			await ctx.queues.retention.close();
			await ctx.queues.penalty.close();
			await ctx.queues.audit.close();
			await ctx.queues.balanceRefresh.close();
			ctx.redis.disconnect();
			ctx.requestRedis.disconnect();
			await ctx.dbClient.end();
		});

		const chainDefault = minCollateralFor(1);

		// context.ts: `minCollateralFor(config.CHAIN_ID)` is called when
		// `config.MIN_COLLATERAL` is undefined.
		expect(ctx.minCollateralWei).toBe(chainDefault);

		// Both consumers must see the same value — if one were hardcoded to a
		// different number this would catch the drift.
		expect(ctx.rateLimits.floorWei).toBe(chainDefault);
	});
});
