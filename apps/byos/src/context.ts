import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";
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
	type Queues,
	setupJobSchedulers,
} from "./infra/jobs/index.js";
import { OrderbookClient } from "./infra/orderbook.js";
import { createRedisRateLimiter } from "./infra/rate-limit.js";

export interface AppContext {
	db: Db;
	dbClient: ReturnType<typeof createDb>["client"];
	redis: Redis;
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

	// Redis
	const redis = createRedisConnection(config.REDIS_URL);
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

	// Rate limiting. The limiter always runs — it needs Redis, which is
	// already a hard dependency, not RPC.
	const rateLimiter = createRedisRateLimiter(redis);
	const rateLimits = {
		windowSecs: config.RATE_LIMIT_WINDOW_SECS,
		ipPerWindow: config.RATE_LIMIT_IP_PER_WINDOW,
		tier: {
			rateUnitWei: BigInt(config.RATE_UNIT_WEI),
			ratePerUnit: config.RATE_PER_UNIT,
			minRate: config.RATE_MIN_PER_WINDOW,
			maxRate: config.RATE_MAX_PER_WINDOW,
		},
		// MIN_COLLATERAL, not the validator's gas-coupled threshold: the
		// synchronous gate must sit at or below whatever the validator
		// enforces so it can never reject a proposal the validator accepts.
		floorWei: config.MIN_COLLATERAL ? BigInt(config.MIN_COLLATERAL) : 0n,
	};

	// Blockchain (optional — depends on RPC_URL)
	let validator: ValidateProposal = acceptAll;
	let operator: EscrowOperator | null = null;
	let balances: BalanceCache = unknownBalances;
	let balanceRefresh: BalanceRefreshConfig | null = null;

	if (config.RPC_URL) {
		const transport = http(config.RPC_URL);
		const publicClient = createPublicClient({ transport });

		// Fail-fast RPC check
		try {
			await publicClient.getBlockNumber();
		} catch (e) {
			throw new Error(`RPC unreachable at ${config.RPC_URL}: ${e}`);
		}
		logger.info("rpc connected");

		// The config schema requires these alongside RPC_URL, so the casts
		// cannot see undefined — same guarantee clap's requires_all gives Rust.
		const escrowAddress = config.ESCROW_ADDRESS as Address;
		const minCollateral = BigInt(config.MIN_COLLATERAL as string);

		// Escrow validator
		const escrowValidator = new EscrowValidator(
			publicClient,
			escrowAddress,
			minCollateral,
			gasPriceRef,
		);

		// Orderbook client
		const orderbook = new OrderbookClient(config.ORDERBOOK_URL as string);

		// Simulation validator
		const simulationValidator = new SimulationValidator(
			publicClient,
			orderbook,
			config.SETTLEMENT_ADDRESS as Address,
			escrowAddress,
			config.TRAMPOLINE_FACTORY as Address,
			gasPriceRef,
			BigInt(config.MIN_PROPOSAL_SCORE),
		);

		validator = new ProposalValidator(escrowValidator, simulationValidator);

		// Request-path balance cache and the job that keeps it fresh.
		const balanceStore = createRedisBalanceStore(redis, {
			negativeTtlSecs: config.BALANCE_NEGATIVE_TTL_SECS,
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
			const walletClient = createWalletClient({ account, transport });
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
