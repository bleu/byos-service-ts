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
				new Promise<void>((res, rej) => {
					// closeAllConnections() drops keep-alive sockets that viem's
					// undici transport may hold open; without it server.close() waits
					// for them to drain and the afterAll hangs.
					server.closeAllConnections();
					server.close((err) => (err ? rej(err) : res()));
				});
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
// Standard config (RPC + operator)
// ---------------------------------------------------------------------------

describe("buildContext", () => {
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

	// Deleting `validator = new ProposalValidator(escrowValidator, simulationValidator)`
	// would leave validator as something other than ProposalValidator.
	it("validator is a ProposalValidator", () => {
		expect(ctx.validator).toBeInstanceOf(ProposalValidator);
	});

	// Deleting `balanceRefresh = { store: balanceStore, ... }` would leave it null.
	it("balanceRefresh is wired", () => {
		expect(ctx.balanceRefresh).not.toBeNull();
	});

	// Deleting `balanceRefresh.floorWei = rateLimits.floorWei` would leave it 0.
	it("balanceRefresh.floorWei matches rateLimits.floorWei", () => {
		// context.ts: `floorWei: rateLimits.floorWei` in the balanceRefresh object.
		// If that line passed 0n instead of rateLimits.floorWei, this assertion fails.
		expect(ctx.balanceRefresh.floorWei).toBe(ctx.rateLimits.floorWei);
	});

	// Deleting `operator = new EscrowOperator(...)` would leave operator null/undefined.
	it("operator is an EscrowOperator", () => {
		expect(ctx.operator).toBeInstanceOf(EscrowOperator);
	});

	// Deleting `const trampolineFactory = config.TRAMPOLINE_FACTORY as Address` or
	// failing to return it in the context object would break this.
	it("trampolineFactory is the TRAMPOLINE_FACTORY from config", () => {
		expect(ctx.trampolineFactory).toBe(FAKE_TRAMPOLINE_FACTORY);
	});
});

// ---------------------------------------------------------------------------
// MIN_COLLATERAL override reaches the balance-refresh floor gate
// ---------------------------------------------------------------------------

describe("buildContext — MIN_COLLATERAL override", () => {
	// Verifies that the custom floor reaches balanceRefresh.floorWei (the
	// request-path escrow floor gate) when RPC is active.
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
			MIN_COLLATERAL: "999000000000000000", // 0.999 ETH — distinct from any chain default
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

	// Deleting the `floorWei: rateLimits.floorWei` line inside the balanceRefresh
	// object literal would leave it 0n or undefined.
	it("MIN_COLLATERAL override reaches balanceRefresh.floorWei and minCollateralWei", () => {
		const CUSTOM = 999000000000000000n;
		// context.ts: `floorWei: rateLimits.floorWei` in the balanceRefresh object.
		expect(ctx.balanceRefresh.floorWei).toBe(CUSTOM);
		// Consistency: the rate-limit gate and the balance-refresh gate must agree.
		expect(ctx.rateLimits.floorWei).toBe(CUSTOM);
		expect(ctx.minCollateralWei).toBe(CUSTOM);
	});
});
