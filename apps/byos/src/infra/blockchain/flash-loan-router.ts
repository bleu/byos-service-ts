import type { Logger } from "pino";
import type { Address } from "viem";
import { z } from "zod";

export const DEFAULT_FLASH_LOAN_ROUTER: Address = "0x9da8b48441583a2b93e2ef8213aad0ec0b392c69";
export const FLASH_LOAN_NETWORKS_URL =
	"https://raw.githubusercontent.com/cowprotocol/flash-loan-router/main/networks.json";

const deploymentSchema = z.object({
	address: z
		.string()
		.regex(/^0x[0-9a-fA-F]{40}$/)
		.refine((v) => !/^0x0{40}$/i.test(v)),
});
const networksSchema = z.object({ FlashLoanRouter: z.record(z.unknown()) });

/** Resolve once at startup, outside the auction hot path. */
export async function resolveFlashLoanRouter(
	chainId: number,
	override?: Address,
	logger?: Logger,
	fetchNetworks: typeof fetch = fetch,
): Promise<Address> {
	if (override) return override;
	try {
		const response = await fetchNetworks(FLASH_LOAN_NETWORKS_URL, {
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw new Error(`Deployment registry returned HTTP ${response.status}`);
		const networks = networksSchema.parse(await response.json());
		return deploymentSchema.parse(networks.FlashLoanRouter[String(chainId)]).address as Address;
	} catch (err) {
		logger?.warn(
			{ err, chainId, address: DEFAULT_FLASH_LOAN_ROUTER },
			"using fallback flash loan router",
		);
		return DEFAULT_FLASH_LOAN_ROUTER;
	}
}
