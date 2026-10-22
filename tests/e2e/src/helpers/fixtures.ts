import {
	createWalletClient,
	http,
	keccak256,
	stringToHex,
	type Transport,
	type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilMainnet } from "./clients.js";
import { ACCOUNTS, CONFIG } from "./config.js";

// Deterministic test-only identities let e2e:up seed isolated accounts in advance.
function identity(name: string) {
	const key = keccak256(stringToHex(`byos-e2e:${name}`));
	return { key, address: privateKeyToAccount(key).address };
}
export function fixtureWallet(identity: {
	key: `0x${string}`;
}): WalletClient<Transport, typeof anvilMainnet, ReturnType<typeof privateKeyToAccount>> {
	return createWalletClient({
		account: privateKeyToAccount(identity.key),
		chain: anvilMainnet,
		transport: http(CONFIG.rpcUrl),
	});
}
export const SCENARIO_SUB_SOLVERS = {
	subSolver: identity("scenario-happy"),
	subSolver2: identity("scenario-simulation"),
	subSolver3: identity("scenario-expiry"),
	subSolver4: identity("scenario-unprofitable"),
	subSolver5: identity("scenario-settled"),
	lateSubSolver: identity("scenario-late"),
};
export const HOOK_TRADER = identity("permit-trader");
export interface E2eFixture {
	trader: { key: `0x${string}`; address: `0x${string}` };
	subSolver: { key: `0x${string}`; address: `0x${string}` };
	seedUsdc: bigint;
	seedWeth: bigint;
	permitOnly: boolean;
}
export const SCENARIO_FIXTURES = Object.fromEntries(
	Object.entries(SCENARIO_SUB_SOLVERS).map(([name, subSolver], index) => [
		name,
		{
			trader:
				[
					ACCOUNTS.trader,
					ACCOUNTS.trader2,
					ACCOUNTS.trader3,
					ACCOUNTS.trader4,
					ACCOUNTS.trader5,
					ACCOUNTS.trader5,
				][index] ?? ACCOUNTS.trader5,
			subSolver,
			seedUsdc: index === 0 ? 20_000_000_000n : 3_000_000_000n,
			seedWeth: 0n,
			permitOnly: false,
		},
	]),
) as Record<keyof typeof SCENARIO_SUB_SOLVERS, E2eFixture>;
export const E2E_FIXTURES = {
	standard: {
		trader: ACCOUNTS.trader,
		subSolver: ACCOUNTS.subSolver,
		seedUsdc: 20_000_000_000n,
		seedWeth: 3n * 10n ** 18n,
		permitOnly: false,
	},
	stress: {
		trader: ACCOUNTS.trader,
		subSolver: ACCOUNTS.subSolver2,
		seedUsdc: 20_000_000_000n,
		seedWeth: 3n * 10n ** 18n,
		permitOnly: false,
	},
	hooks: {
		trader: HOOK_TRADER,
		subSolver: ACCOUNTS.subSolver,
		seedUsdc: 5_000_000_000n,
		seedWeth: 0n,
		permitOnly: true,
	},
	...SCENARIO_FIXTURES,
};
