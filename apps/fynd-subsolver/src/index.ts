import "dotenv/config";
import { byosDomain, TrampolineFactoryAbi } from "@byos/common";
import {
	ByosClient,
	FyndConfigurationError,
	FyndProvider,
	OrderbookClient,
	RequestBudget,
} from "@byos/subsolver-core";
import { FyndClient } from "@kayibal/fynd-client";
import pino from "pino";
import type { Address } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "./config.js";
import { FyndSubsolver } from "./fynd-subsolver.js";

const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForFyndStartup(fynd: FyndProvider, logger: pino.Logger): Promise<void> {
	while (true) {
		try {
			await fynd.initialize();
			return;
		} catch (error) {
			if (error instanceof FyndConfigurationError) throw error;
			logger.warn({ err: error }, "waiting for Fynd sidecar info endpoint");
			await delay(2_000);
		}
	}
}

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
		address: config.toml.trampolineFactory,
		abi: TrampolineFactoryAbi,
		functionName: "addressOf",
		args: [account.address],
	});
	logger.info({ trampoline, subSolver: account.address }, "resolved Fynd trampoline");
	const domain = byosDomain(config.toml.chainId, config.toml.trampolineFactory);
	const wallet = createWalletClient({ account, transport });
	const signFn = (params: unknown) => wallet.signTypedData(params as never);
	const fynd = new FyndProvider({
		client: new FyndClient({ baseUrl: config.fyndUrl, timeoutMs: 7000, retry: { maxAttempts: 2 } }),
		chainId: config.toml.chainId,
		trampoline: trampoline as Address,
		settlement: config.gpv2Settlement,
		slippageBps: config.fyndSlippageBps,
		maxQuoteAgeSeconds: config.fyndMaxQuoteAgeSeconds,
	});
	await waitForFyndStartup(fynd, logger);
	const subsolver = new FyndSubsolver(
		config,
		new OrderbookClient(config.orderBookUrl),
		new ByosClient(config.byosUrl, domain, signFn),
		fynd,
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
		timer = setTimeout(tick, config.toml.pollInterval * 1000);
	};
	let timer = setTimeout(tick, config.toml.pollInterval * 1000);
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
