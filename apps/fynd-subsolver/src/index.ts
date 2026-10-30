import "dotenv/config";
import { byosDomain, TrampolineFactoryAbi } from "@byos/common";
import {
	AwsOrderbookClient,
	ByosClient,
	FyndConfigurationError,
	FyndProvider,
	OrderbookClient,
	OrderFilter,
	RequestBudget,
	SolveOrderbookClient,
} from "@byos/subsolver-core";
import { serve } from "@hono/node-server";
import { FyndClient } from "@kayibal/fynd-client";
import { Hono } from "hono";
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
		address: config.trampolineFactory,
		abi: TrampolineFactoryAbi,
		functionName: "addressOf",
		args: [account.address],
	});
	logger.info({ trampoline, subSolver: account.address }, "resolved Fynd trampoline");
	const domain = byosDomain(config.chainId, config.trampolineFactory);
	const wallet = createWalletClient({ account, transport });
	const signFn = (params: unknown) => wallet.signTypedData(params as never);
	const fynd = new FyndProvider({
		client: new FyndClient({ baseUrl: config.fyndUrl, timeoutMs: 7000, retry: { maxAttempts: 2 } }),
		chainId: config.chainId,
		trampoline: trampoline as Address,
		settlement: config.gpv2Settlement,
		slippageBps: config.fyndSlippageBps,
		maxQuoteAgeSeconds: config.fyndMaxQuoteAgeSeconds,
	});
	await waitForFyndStartup(fynd, logger);

	let orderbook: { solvableOrders(): Promise<import("@byos/subsolver-core").OrderbookOrder[]> };
	if (config.discoveryMethod === "aws") {
		orderbook = new AwsOrderbookClient(config.discoveryUrl, publicClient, config.gpv2Settlement, {
			logger,
		});
	} else if (config.discoveryMethod === "solve") {
		const solveClient = new SolveOrderbookClient(logger);
		const app = new Hono();
		app.post("/solve", async (c) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "invalid json" }, 400);
			}
			solveClient.receive(body);
			return c.json({}, 200);
		});
		serve({ fetch: app.fetch, port: config.solvePort }, (info) => {
			logger.info({ port: info.port }, "solve discovery listener started");
		});
		orderbook = solveClient;
	} else {
		orderbook = new OrderbookClient(config.discoveryUrl);
	}

	const orderFilter = new OrderFilter({
		freshOrderWindowSecs: config.freshOrderWindowSecs,
		closeToExecutionTopN: config.closeToExecutionTopN,
	});

	const subsolver = new FyndSubsolver(
		config,
		orderbook,
		new ByosClient(config.byosUrl, domain, signFn),
		fynd,
		domain,
		signFn,
		logger,
		new RequestBudget(config.byosRequestsPerMinute, config.byosReadReserve),
		orderFilter,
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
