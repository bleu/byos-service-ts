import { resolve } from "node:path";
import {
	escrowAddressFor,
	evmChainFor,
	minCollateralFor,
	orderbookUrlFor,
	settlementAddressFor,
	trampolineFactoryFor,
} from "@byos/common";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Config, rateLimitsFromConfig } from "./config.js";
import { createDb, type Db } from "./db/index.js";
import type { AuditEvent } from "./domain/audit.js";
import { type BalanceCache, unknownBalances } from "./domain/balance-cache.js";
import type { RateLimiter, TierParams } from "./domain/rate-limit.js";
import { acceptAll, type ValidateProposal } from "./domain/validator.js";
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
	operator: EscrowOperator | null;
	rateLimiter: RateLimiter;
	balances: BalanceCache;
	rateLimits: { windowSecs: number; ipPerWindow: number; tier: TierParams; floorWei: bigint };
	/** Null when no RPC is configured — nothing to refresh from. */
	balanceRefresh: BalanceRefreshConfig | null;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
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
	const minCollateralWei =
		config.MIN_COLLATERAL !== undefined
			? BigInt(config.MIN_COLLATERAL)
			: minCollateralFor(config.CHAIN_ID);

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

	// TrampolineFactory is needed for EIP-712 domain even without RPC.
	// Resolve it once here, failing fast if neither the override nor the
	// per-chain table provides an address.
	const trampolineFactory: Address = (() => {
		if (config.TRAMPOLINE_FACTORY) return config.TRAMPOLINE_FACTORY as Address;
		const addr = trampolineFactoryFor(config.CHAIN_ID);
		if (!addr) {
			throw new Error(
				`No TRAMPOLINE_FACTORY for chain ${config.CHAIN_ID} — set TRAMPOLINE_FACTORY env var`,
			);
		}
		return addr;
	})();

	// Blockchain (optional — depends on RPC_URL)
	let validator: ValidateProposal = acceptAll;
	let operator: EscrowOperator | null = null;
	let balances: BalanceCache = unknownBalances;
	let balanceRefresh: BalanceRefreshConfig | null = null;

	if (config.RPC_URL) {
		const transport = http(config.RPC_URL);
		// The chain is what lets viem resolve Multicall3 for the batched
		// balance reads; without it every multicall throws before it reaches
		// the RPC.
		const publicClient = createPublicClient({ chain, transport });

		// Fail-fast RPC check
		try {
			await publicClient.getBlockNumber();
		} catch (e) {
			throw new Error(`RPC unreachable at ${config.RPC_URL}: ${e}`);
		}
		logger.info("rpc connected");

		// Resolve per-chain addresses, allowing env var overrides.
		const escrowAddress: Address = (() => {
			if (config.ESCROW_ADDRESS) return config.ESCROW_ADDRESS as Address;
			const addr = escrowAddressFor(config.CHAIN_ID);
			if (!addr) {
				throw new Error(
					`No ESCROW_ADDRESS for chain ${config.CHAIN_ID} — set ESCROW_ADDRESS env var`,
				);
			}
			return addr;
		})();

		const settlementAddress: Address =
			(config.SETTLEMENT_ADDRESS as Address | undefined) ?? settlementAddressFor(config.CHAIN_ID);

		const orderbookUrl: string = config.ORDERBOOK_URL ?? orderbookUrlFor(config.CHAIN_ID);

		// Escrow validator
		const escrowValidator = new EscrowValidator(
			publicClient,
			escrowAddress,
			minCollateralWei,
			gasPriceRef,
		);

		// Orderbook client
		const orderbook = new OrderbookClient(orderbookUrl);

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

		validator = new ProposalValidator(escrowValidator, simulationValidator);

		// Request-path balance cache and the job that keeps it fresh.
		const balanceStore = createRedisBalanceStore(requestRedis, {
			negativeTtlSecs: config.BALANCE_NEGATIVE_TTL_SECS,
			balanceTtlSecs: config.BALANCE_EVICTION_SECS,
		});
		balances = balanceStore;
		balanceRefresh = {
			store: balanceStore,
			fetchBalances: createEscrowBalanceReader(publicClient, escrowAddress),
			floorWei: rateLimits.floorWei,
			evictionSecs: config.BALANCE_EVICTION_SECS,
			maxActive: config.BALANCE_ACTIVE_SET_MAX,
			batchSize: config.BALANCE_REFRESH_BATCH_SIZE,
			logger: logger.child({ worker: "balance-refresh" }),
		};

		// Operator (optional — depends on OPERATOR_PRIVATE_KEY)
		if (config.OPERATOR_PRIVATE_KEY) {
			const account = privateKeyToAccount(config.OPERATOR_PRIVATE_KEY as Hex);
			const walletClient = createWalletClient({ account, chain, transport });
			operator = new EscrowOperator(walletClient, publicClient, escrowAddress);
			logger.info("escrow operator configured");
		} else {
			logger.warn("no OPERATOR_PRIVATE_KEY — penalty loop disabled");
		}
	} else {
		logger.warn("no RPC_URL — validation disabled, using AcceptAll");
		logger.warn("no RPC_URL — escrow floor gate disabled, every signer at the lowest tier");
	}

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
