import "dotenv/config";
import { byosDomain, TrampolineFactoryAbi } from "@byos/common";
import {
	AwsOrderbookClient,
	ByosClient,
	OrderbookClient,
	RequestBudget,
} from "@byos/subsolver-core";
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
	const orderbook =
		config.discoveryMethod === "aws"
			? new AwsOrderbookClient(config.discoveryUrl, publicClient, config.gpv2Settlement, { logger })
			: new OrderbookClient(config.discoveryUrl);
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
	);
	await subsolver.synchronize(BigInt(Math.floor(Date.now() / 1000)));
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
