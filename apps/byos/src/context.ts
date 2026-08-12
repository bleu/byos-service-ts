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
import { acceptAll, type ValidateProposal } from "./domain/validator.js";
import { EscrowValidator, type GasPriceRef } from "./infra/blockchain/escrow.js";
import { EscrowOperator } from "./infra/blockchain/operator.js";
import { ProposalValidator, SimulationValidator } from "./infra/blockchain/validator.js";
import { enqueueAuditEvent } from "./infra/jobs/audit-worker.js";
import {
	createQueues,
	createRedisConnection,
	type Queues,
	setupJobSchedulers,
} from "./infra/jobs/index.js";
import { OrderbookClient } from "./infra/orderbook.js";

export interface AppContext {
	db: Db;
	dbClient: ReturnType<typeof createDb>["client"];
	redis: Redis;
	queues: Queues;
	config: Config;
	gasPriceRef: GasPriceRef;
	validator: ValidateProposal;
	operator: EscrowOperator | null;
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
		enqueueAuditEvent(queues.audit, event).catch((e) => {
			logger.error({ err: e }, "failed to enqueue audit event");
		});
	};

	// Blockchain (optional — depends on RPC_URL)
	let validator: ValidateProposal = acceptAll;
	let operator: EscrowOperator | null = null;

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

		const escrowAddress = config.ESCROW_ADDRESS as Address;
		const minCollateral = BigInt(config.MIN_COLLATERAL ?? "0");

		// Escrow validator
		const escrowValidator = new EscrowValidator(
			publicClient,
			escrowAddress,
			minCollateral,
			gasPriceRef,
		);

		// Orderbook client
		const orderbook = new OrderbookClient(config.ORDERBOOK_URL!);

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
	}

	// Setup job schedulers
	await setupJobSchedulers(queues, {
		validationIntervalSecs: config.VALIDATION_INTERVAL_SECS,
		retentionSweepIntervalSecs: config.RETENTION_SWEEP_INTERVAL_SECS,
		penaltyIntervalSecs: config.VALIDATION_INTERVAL_SECS, // same interval as validation
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
		onAuditEvent,
		logger,
	};
}
