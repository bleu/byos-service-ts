import "dotenv/config";
import { byosDomain, TrampolineFactoryAbi } from "@byos/common";
import {
	AwsOrderbookClient,
	ByosClient,
	createHealthApp,
	createSolveApp,
	OrderbookClient,
	OrderFilter,
	RequestBudget,
	SolveOrderbookClient,
} from "@byos/subsolver-core";
import { serve } from "@hono/node-server";
import pino from "pino";
import type { Address } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BinanceClient } from "./binance-client.js";
import { BinanceSubsolver } from "./binance-subsolver.js";
import { parseConfig } from "./config.js";

async function main() {
	const config = parseConfig();
	const logger = pino({
		level: config.logLevel,
		...(config.jsonLogs ? {} : { transport: { target: "pino-pretty" } }),
	});
	const transport = http(config.rpcUrl);
	const publicClient = createPublicClient({ transport });
	const account = privateKeyToAccount(config.privateKey);
	const trampoline = await publicClient.readContract({
		address: config.trampolineFactory,
		abi: TrampolineFactoryAbi,
		functionName: "addressOf",
		args: [account.address],
	});
	logger.info({ trampoline, subSolver: account.address }, "resolved Binance trampoline");
	const domain = byosDomain(config.chainId, config.trampolineFactory);
	const wallet = createWalletClient({ account, transport });
	const signFn = (params: unknown) => wallet.signTypedData(params as never);
	const binanceClient = new BinanceClient(
		config.binanceApiKey,
		config.binanceSecretKey,
		config.chainId,
	);
	const solveClient =
		config.discoveryMethod === "solve" ? new SolveOrderbookClient(logger) : undefined;
	let orderbook: { solvableOrders(): Promise<import("@byos/subsolver-core").OrderbookOrder[]> };
	if (config.discoveryMethod === "aws") {
		orderbook = new AwsOrderbookClient(config.discoveryUrl, publicClient, config.gpv2Settlement, {
			logger,
		});
	} else if (solveClient) {
		orderbook = solveClient;
	} else {
		orderbook = new OrderbookClient(config.discoveryUrl);
	}

	const orderFilter = new OrderFilter({
		closeToExecutionTopN: config.closeToExecutionTopN,
	});

	const subsolver = new BinanceSubsolver(
		config,
		orderbook,
		new ByosClient(config.byosUrl, domain, signFn),
		binanceClient,
		trampoline as Address,
		domain,
		signFn,
		logger,
		new RequestBudget(config.byosRequestsPerMinute, config.byosReadReserve),
		orderFilter,
	);
	await subsolver.synchronize(BigInt(Math.floor(Date.now() / 1000)));
	if (config.discoveryMethod === "solve" && solveClient) {
		const app = createSolveApp(solveClient, config.subsolverBearer, async () => {
			try {
				await subsolver.pollOnce(BigInt(Math.floor(Date.now() / 1000)));
			} catch (error) {
				logger.warn({ err: error }, "solve cycle failed");
			}
		});
		serve({ fetch: app.fetch, port: config.solvePort }, (info) => {
			logger.info({ port: info.port }, "solve discovery listener started");
		});
		const shutdown = () => {
			logger.info("shutting down");
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
		return;
	}
	// Polling modes also expose readiness after initialization and synchronization.
	serve({ fetch: createHealthApp().fetch, port: config.solvePort }, (info) => {
		logger.info({ port: info.port }, "health listener started");
	});
	const tick = async () => {
		try {
			await subsolver.pollOnce(BigInt(Math.floor(Date.now() / 1000)));
		} catch (error) {
			logger.warn({ err: error }, "poll failed");
		}
		timer = setTimeout(tick, config.pollIntervalSeconds * 1000);
	};
	let timer = setTimeout(tick, config.pollIntervalSeconds * 1000);
	const shutdown = () => {
		logger.info("shutting down");
		clearTimeout(timer);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((error) => {
	console.error("fatal:", error);
	process.exit(1);
});
