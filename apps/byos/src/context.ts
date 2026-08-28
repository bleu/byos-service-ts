import { resolve } from "node:path";
import { evmChainFor, orderbookUrlFor, settlementAddressFor } from "@byos/common";
import type { SupportedChainId } from "@cowprotocol/cow-sdk";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Address, Chain, Hex, PublicClient, Transport } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Config, rateLimitsFromConfig } from "./config.js";
import { createDb, type Db } from "./db/index.js";
import type { AuditEvent } from "./domain/audit.js";
import type { BalanceCache } from "./domain/balance-cache.js";
import type { RateLimiter, TierParams } from "./domain/rate-limit.js";
import type { ValidateProposal } from "./domain/validator.js";
import { createRedisBalanceStore } from "./infra/balance-cache.js";
import {
	createEscrowBalanceReader,
	EscrowValidator,
	type GasPriceRef,
} from "./infra/blockchain/escrow.js";
import { EscrowOperator } from "./infra/blockchain/operator.js";
import { ProposalValidator, SimulationValidator } from "./infra/blockchain/validator.js";
import { enqueueAuditEvent } from "./infra/jobs/audit-worker.js";
import type { BalanceRefreshConfig } from "./infra/jobs/balance-refresh.js";
import {
	createQueues,
	createRedisConnection,
	createRequestPathRedisConnection,
	type Queues,
	setupJobSchedulers,
} from "./infra/jobs/index.js";
import { OrderbookClient } from "./infra/orderbook.js";
import { createRedisRateLimiter } from "./infra/rate-limit.js";
import * as store from "./infra/storage.js";

export interface AppContext {
	db: Db;
	dbClient: ReturnType<typeof createDb>["client"];
	redis: Redis;
	/** Request-path connection: bounded commands, no offline queue. */
	requestRedis: Redis;
	/** Resolved minimum escrow collateral: the chain's default, or the
	 * MIN_COLLATERAL override. Feeds the validator threshold, the penalty
	 * parameter c_l, and the request-path escrow floor gate. */
	minCollateralWei: bigint;
	/** Resolved TrampolineFactory address: the chain's default from
	 * `trampolineFactoryFor`, or the TRAMPOLINE_FACTORY override. */
	trampolineFactory: Address;
	queues: Queues;
	config: Config;
	gasPriceRef: GasPriceRef;
	validator: ValidateProposal;
	operator: EscrowOperator;
	rateLimiter: RateLimiter;
	balances: BalanceCache;
	rateLimits: { windowSecs: number; ipPerWindow: number; tier: TierParams; floorWei: bigint };
	balanceRefresh: BalanceRefreshConfig;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

/**
 * Creates the one public client shared by validation, balance refresh, and
 * settlement observation. Batching only coalesces reads issued together; it
 * never waits to collect more work.
 */
export function createSharedPublicClient(chain: Chain, transport: Transport): PublicClient {
	return createPublicClient({ chain, transport, batch: { multicall: { wait: 0 } } });
}

export async function buildContext(config: Config, logger: Logger): Promise<AppContext> {
	// Database
	const { db, client: dbClient } = createDb(config.DATABASE_URL);
	const migrationsFolder = resolve(import.meta.dirname, "../drizzle");
	await migrate(db, { migrationsFolder });
	logger.info("database connected and migrated");

	// Redis. Two connections on purpose — see
	// createRequestPathRedisConnection for why the options differ.
	const redis = createRedisConnection(config.REDIS_URL);
	const requestRedis = createRequestPathRedisConnection(config.REDIS_URL);
	logger.info("redis connected");

	// Queues
	const queues = createQueues(redis);

	// Gas price
	const gasPriceRef: GasPriceRef = {
		value: config.DEFAULT_GAS_PRICE ? BigInt(config.DEFAULT_GAS_PRICE) : 0n,
	};

	// Audit event handler — enqueues to BullMQ for durable persistence
	const onAuditEvent = (event: AuditEvent) => {
		const enqueue = async (retries = 2) => {
			try {
				await enqueueAuditEvent(queues.audit, event);
			} catch (err) {
				if (retries > 0) {
					await enqueue(retries - 1);
				} else {
					logger.error({ err }, "failed to enqueue audit event after retries");
				}
			}
		};
		enqueue();
	};

	// One resolution of the collateral floor, shared by everything that needs
	// it, so the validator, the penalty loop and the floor gate cannot drift.
	const chain = evmChainFor(config.CHAIN_ID);
	const minCollateralWei = BigInt(config.MIN_COLLATERAL);

	if (minCollateralWei === 0n) {
		// The negative set is what bounds the refresh population by capital
		// rather than by attacker effort; with a zero floor nothing is ever
		// demoted into it and only BALANCE_ACTIVE_SET_MAX remains (ADR-0015).
		logger.warn(
			"MIN_COLLATERAL is 0 — escrow floor gate disabled and the balance refresh set is bounded by size alone",
		);
	}

	// Rate limiting. The limiter always runs — it needs Redis, which is
	// already a hard dependency, not RPC.
	const rateLimiter = createRedisRateLimiter(requestRedis);
	// The collateral floor, not the validator's gas-coupled threshold: the
	// synchronous gate must sit at or below whatever the validator enforces so
	// it can never reject a proposal the validator accepts.
	const rateLimits = rateLimitsFromConfig(config, minCollateralWei);

	// TrampolineFactory is needed for EIP-712 domain construction.
	// Required in config, so always present here.
	const trampolineFactory = config.TRAMPOLINE_FACTORY as Address;

	// Blockchain
	const transport = http(config.RPC_URL);
	// The chain is what lets viem resolve Multicall3 for the batched
	// balance reads; without it every multicall throws before it reaches
	// the RPC.
	const publicClient = createSharedPublicClient(chain, transport);

	// Fail-fast RPC check
	try {
		await publicClient.getBlockNumber();
	} catch (e) {
		throw new Error(`RPC unreachable at ${config.RPC_URL}: ${e}`);
	}
	logger.info("rpc connected");

	const escrowAddress = config.ESCROW_ADDRESS as Address;

	const settlementAddress: Address =
		(config.SETTLEMENT_ADDRESS as Address | undefined) ?? settlementAddressFor(config.CHAIN_ID);

	// Escrow validator
	const escrowValidator = new EscrowValidator(
		publicClient,
		escrowAddress,
		minCollateralWei,
		gasPriceRef,
		(subSolver, excludeId) => store.inflightGasUsedBySubSolver(db, subSolver, excludeId),
	);

	// Orderbook client. Resolve the base URL explicitly so that local chains
	// (e.g. foundry/31337) get the LOCAL_ORDERBOOK_URL fallback from
	// orderbookUrlFor rather than an undefined SDK base URL.
	// ORDERBOOK_URL overrides it (barn/staging).
	const orderbookUrl = config.ORDERBOOK_URL ?? orderbookUrlFor(config.CHAIN_ID);
	const orderbook = new OrderbookClient(config.CHAIN_ID as SupportedChainId, orderbookUrl);

	// Simulation validator
	const simulationValidator = new SimulationValidator(
		publicClient,
		orderbook,
		settlementAddress,
		escrowAddress,
		trampolineFactory,
		gasPriceRef,
		BigInt(config.MIN_PROPOSAL_SCORE),
	);

	const validator = new ProposalValidator(escrowValidator, simulationValidator);

	// Request-path balance cache and the job that keeps it fresh.
	const balanceStore = createRedisBalanceStore(requestRedis, {
		negativeTtlSecs: config.BALANCE_NEGATIVE_TTL_SECS,
		balanceTtlSecs: config.BALANCE_EVICTION_SECS,
	});
	const balances: BalanceCache = balanceStore;
	const balanceRefresh: BalanceRefreshConfig = {
		store: balanceStore,
		fetchBalances: createEscrowBalanceReader(publicClient, escrowAddress),
		floorWei: rateLimits.floorWei,
		evictionSecs: config.BALANCE_EVICTION_SECS,
		maxActive: config.BALANCE_ACTIVE_SET_MAX,
		batchSize: config.BALANCE_REFRESH_BATCH_SIZE,
		logger: logger.child({ worker: "balance-refresh" }),
	};

	// Operator
	const account = privateKeyToAccount(config.OPERATOR_PRIVATE_KEY as Hex);
	const walletClient = createWalletClient({ account, chain, transport });
	const operator = new EscrowOperator(walletClient, publicClient, escrowAddress);
	logger.info("escrow operator configured");

	// Setup job schedulers
	await setupJobSchedulers(queues, {
		validationIntervalSecs: config.VALIDATION_INTERVAL_SECS,
		retentionSweepIntervalSecs: config.RETENTION_SWEEP_INTERVAL_SECS,
		penaltyIntervalSecs: config.VALIDATION_INTERVAL_SECS, // same interval as validation
		balanceRefreshIntervalSecs: config.BALANCE_REFRESH_INTERVAL_SECS,
	});

	return {
		db,
		dbClient,
		redis,
		requestRedis,
		minCollateralWei,
		trampolineFactory,
		queues,
		config,
		gasPriceRef,
		validator,
		operator,
		rateLimiter,
		balances,
		rateLimits,
		balanceRefresh,
		onAuditEvent,
		logger,
	};
}
