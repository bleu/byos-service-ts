import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { createPublicClient, http, isAddress } from "viem";
import { AwsOrderbookClient } from "../packages/subsolver-core/src/aws-orderbook-client.js";

// Exercise the actual discovery client against live RPC/S3 without signing,
// quoting, submitting proposals, or requiring a running BYOS service.
async function main() {
	const envPath = process.argv[2] ?? "env/bnb-prod/.env.binance-subsolver";
	const env = parse(readFileSync(envPath));
	const { RPC_URL, DISCOVERY_URL, GPV2_SETTLEMENT } = env;
	if (!RPC_URL || !DISCOVERY_URL || !GPV2_SETTLEMENT || !isAddress(GPV2_SETTLEMENT)) {
		throw new Error("Environment requires RPC_URL, DISCOVERY_URL and a valid GPV2_SETTLEMENT");
	}
	if (env.DISCOVERY_METHOD !== "aws") {
		throw new Error("This smoke test requires DISCOVERY_METHOD=aws");
	}
	const logger = {
		debug: (obj: object, msg: string) => console.log(msg, JSON.stringify(obj)),
		info: (obj: object, msg: string) => console.log(msg, JSON.stringify(obj)),
		warn: (obj: object | string, msg?: string) =>
			console.warn(msg ?? obj, msg ? JSON.stringify(obj) : ""),
	};
	const publicClient = createPublicClient({
		transport: http(RPC_URL, { timeout: 15_000, retryCount: 0 }),
	});
	const client = new AwsOrderbookClient(DISCOVERY_URL, publicClient, GPV2_SETTLEMENT, { logger });
	let pollsWithOrders = 0;
	for (let poll = 1; poll <= 3; poll++) {
		const started = Date.now();
		const orders = await client.solvableOrders();
		if (orders.length > 0) pollsWithOrders++;
		console.log(
			"discovery result",
			JSON.stringify({
				poll,
				orders: orders.length,
				sellOrders: orders.filter((order) => order.kind === "sell").length,
				elapsedMs: Date.now() - started,
			}),
		);
		if (poll < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	if (pollsWithOrders === 0) {
		throw new Error("No orders discovered in three polls; inspect the discovery logs above");
	}
}

main().catch((error: unknown) => {
	// Transport errors can include credential-bearing URLs; do not print them.
	console.error("AWS discovery smoke test failed", {
		errorType: error instanceof Error ? error.name : "unknown",
	});
	process.exitCode = 1;
});
