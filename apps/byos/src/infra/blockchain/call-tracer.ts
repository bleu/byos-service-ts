import type { Hex } from "viem";
import { z } from "zod";

/** Availability failures only: never replace an EVM revert or invalid request. */
export function shouldFallbackToCallTracer(error: unknown): boolean {
	let available = false;
	for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
		const e = error as Record<string, unknown>;
		if (e.code === 3 || e.code === -32602 || e.name === "ContractFunctionRevertedError")
			return false;
		if (typeof e.status === "number" && e.status >= 500 && e.status < 600) available = true;
		if (e.code === -32601) available = true;
		// viem preserves a JSON-RPC error body from HTTP 500 but discards HTTP status.
		// Match the dRPC error observed in staging without treating all code 19s as retryable.
		if (
			e.code === 19 &&
			[e.message, e.details].some(
				(text) =>
					typeof text === "string" && text.startsWith("Temporary internal error. Please retry"),
			)
		)
			available = true;
		error = e.cause;
	}
	return available;
}

const quantity = z
	.string()
	.regex(/^0x[0-9a-f]+$/i)
	.transform((value) => value as Hex);
const bytes = z
	.string()
	.regex(/^0x(?:[0-9a-f]{2})*$/i)
	.transform((value) => value as Hex);
const logSchema = z.object({
	address: z
		.string()
		.regex(/^0x[0-9a-f]{40}$/i)
		.transform((value) => value as Hex),
	topics: z.array(
		z
			.string()
			.regex(/^0x[0-9a-f]{64}$/i)
			.transform((value) => value as Hex),
	),
	data: bytes,
});

type TraceLog = z.infer<typeof logSchema>;
interface CallTrace {
	type: string;
	gasUsed?: Hex;
	output?: Hex;
	error?: string;
	revertReason?: string;
	logs?: TraceLog[];
	calls?: CallTrace[];
}
const traceSchema: z.ZodType<CallTrace, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.object({
		type: z.string().min(1),
		gasUsed: quantity.optional(),
		output: bytes.optional(),
		error: z.string().min(1).optional(),
		revertReason: z.string().optional(),
		logs: z.array(logSchema).optional(),
		calls: z.array(traceSchema).optional(),
	}),
);

export function parseEstimatedGas(result: unknown): Hex {
	const gas = quantity.parse(result);
	if (BigInt(gas) <= 0n) throw new Error("eth_estimateGas returned non-positive gas");
	return gas;
}

/** Normalize callTracer to the call result consumed by the existing validation gates. */
export function normalizeCallTrace(result: unknown) {
	const trace = traceSchema.parse(result);
	if (trace.type !== "CALL") throw new Error("callTracer returned an unexpected root call type");
	const failed = trace.error !== undefined || trace.revertReason !== undefined;
	if (!failed && (trace.gasUsed === undefined || BigInt(trace.gasUsed) <= 0n)) {
		throw new Error("callTracer returned missing or non-positive gasUsed");
	}
	const logs: { address: Hex; topics: [Hex, ...Hex[]]; data: Hex }[] = [];
	const collectLogs = (frame: CallTrace): void => {
		// A caught revert can leave a successful parent. Its descendants' logs
		// are still discarded by the EVM and must never supply an Executed delta.
		if (frame.error !== undefined || frame.revertReason !== undefined) return;
		for (const log of frame.logs ?? []) {
			const [first, ...rest] = log.topics;
			if (first !== undefined) logs.push({ ...log, topics: [first, ...rest] });
		}
		for (const child of frame.calls ?? []) collectLogs(child);
	};
	collectLogs(trace);
	const returnData = trace.output ?? "0x";
	return {
		status: (failed ? "0x0" : "0x1") as Hex,
		returnData,
		// The root already includes descendants; summing frames double-counts gas.
		gasUsed: trace.gasUsed ?? "0x0",
		logs,
		error: failed
			? {
					message: trace.revertReason ?? trace.error ?? "execution reverted",
					code: 3,
					data: returnData,
				}
			: undefined,
	};
}
