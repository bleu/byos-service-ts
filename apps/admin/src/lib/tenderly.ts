import type { SimulationFailureParams as BaseSimulationParams } from "@byos/common";

export interface TenderlyCredentials {
	account: string;
	project: string;
	accessKey: string;
}

export interface SimulationParams extends BaseSimulationParams {
	stateOverrides?: Record<string, { code?: string; stateDiff?: Record<string, string> }>;
}

export const TENDERLY_STORAGE_KEY = "byos:tenderly";

export function isTenderlyCredentials(value: unknown): value is TenderlyCredentials {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.account === "string" &&
		/^[\w-][\w.-]*$/.test(c.account) &&
		typeof c.project === "string" &&
		/^[\w-][\w.-]*$/.test(c.project) &&
		typeof c.accessKey === "string" &&
		c.accessKey.trim().length > 0 &&
		!/[\r\n]/.test(c.accessKey)
	);
}

export function simulationRequest(params: SimulationParams) {
	const blockNumber = Number(params.blockNumber);
	if (!/^\d+$/.test(params.blockNumber) || !Number.isSafeInteger(blockNumber)) {
		throw new Error("Invalid saved simulation block number.");
	}
	return {
		network_id: String(params.chainId),
		block_number: blockNumber,
		block_header: { timestamp: `0x${params.timestamp.toString(16)}` },
		from: params.from,
		to: params.to,
		input: params.calldata,
		value: "0",
		gas: 30_000_000,
		gas_price: "0",
		save: true,
		save_if_fails: true,
		simulation_type: "full",
		state_objects: Object.fromEntries(
			Object.entries(params.stateOverrides ?? {}).map(([address, override]) => [
				address,
				{
					...(override.code !== undefined ? { code: override.code } : {}),
					...(override.stateDiff !== undefined ? { storage: override.stateDiff } : {}),
				},
			]),
		),
	};
}

export async function createTenderlySimulation(
	credentials: TenderlyCredentials,
	params: SimulationParams,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const account = encodeURIComponent(credentials.account);
	const project = encodeURIComponent(credentials.project);
	const response = await fetcher(
		`https://api.tenderly.co/api/v1/account/${account}/project/${project}/simulate`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Access-Key": credentials.accessKey },
			body: JSON.stringify(simulationRequest(params)),
			signal: AbortSignal.timeout(60_000),
			cache: "no-store",
		},
	);
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("Tenderly denied access. Check your account, project, and access key.");
		}
		if (response.status === 429) throw new Error("Tenderly rate limit reached. Try again shortly.");
		throw new Error(
			`Tenderly could not create the simulation (HTTP ${response.status}). Check project access and simulation quota.`,
		);
	}
	const data: unknown = await response.json().catch(() => null);
	const simulation =
		data && typeof data === "object" && "simulation" in data ? data.simulation : null;
	const id =
		simulation && typeof simulation === "object" && "id" in simulation ? simulation.id : null;
	// A reverted transaction is still a successful debug simulation.
	if (typeof id !== "string" || !/^[\w-]+$/.test(id)) {
		throw new Error(
			"Tenderly did not return a saved simulation. Check your project and try again.",
		);
	}
	return `https://dashboard.tenderly.co/${account}/${project}/simulator/${id}`;
}
