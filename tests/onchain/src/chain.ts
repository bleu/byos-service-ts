/**
 * Tier-1 chain fixture (mirrors crates/e2e/src/chain.rs):
 *
 * Spawns Anvil with the offline-mode state file, then deploys the BYOS
 * Escrow through the CREATE2 singleton factory. The Escrow constructor
 * also deploys the TrampolineFactory (which embeds the Trampoline creation
 * code), so a single deployment tracks all three contracts.
 *
 * Prerequisites:
 * - `anvil` on PATH (install via `foundryup`)
 * - The offline-mode submodule initialised in the Rust repo
 *   (`git submodule update --init` in byos-service)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
	concat,
	createPublicClient,
	createWalletClient,
	encodeAbiParameters,
	getContractAddress,
	http,
	pad,
} from "viem";
import { foundry } from "viem/chains";

// ---------------------------------------------------------------------------
// Constants matching the Rust fixture
// ---------------------------------------------------------------------------

/** CREATE2 singleton factory (deterministic-deployment-proxy), present in
 *  the offline-mode state at its canonical mainnet address. */
const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** GPv2Settlement at its mainnet address in the offline-mode state. */
export const GPV2_SETTLEMENT: Address = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

/** GPv2AllowListAuthentication proxy at its mainnet address. */
export const GPV2_AUTHENTICATOR: Address = "0x2c4c28DDBdAc9C5E7055b4C863b72eA0149D8aFE";

/** WETH at its mainnet address (present in the offline-mode state). */
export const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** USDC at its mainnet address (TestUSDC with EIP-2612 permit). */
export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** GPv2VaultRelayer -- the spender the user must approve. */
export const VAULT_RELAYER: Address = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";

// ---------------------------------------------------------------------------
// Anvil process management
// ---------------------------------------------------------------------------

export interface ChainFixture {
	/** JSON-RPC endpoint URL (http://127.0.0.1:<port>) */
	rpcUrl: string;
	/** The Escrow address (CREATE2-derived). */
	escrow: Address;
	/** The TrampolineFactory deployed by the Escrow constructor. */
	trampolineFactory: Address;
	/** Anvil's prefunded accounts (addresses). */
	accounts: Address[];
	/** Anvil's prefunded account private keys. */
	keys: Hex[];
	/** Kill the anvil process and clean up temp files. */
	cleanup: () => void;
}

/**
 * Path to the offline-mode anvil state file in the Rust repo.
 * Adjust this if the Rust repo lives elsewhere.
 */
function resolveStatePath(): string {
	// Allow override via environment variable
	const envPath = process.env.ANVIL_STATE_PATH;
	if (envPath) return envPath;

	// Default: assume the Rust repo is a sibling directory
	const candidates = [
		join(__dirname, "../../../../byos-service/offline-mode/state/anvil-state.json"),
		join(process.cwd(), "../byos-service/offline-mode/state/anvil-state.json"),
	];
	for (const p of candidates) {
		try {
			readFileSync(p, { encoding: "utf8", flag: "r" });
			return p;
		} catch {
			// try next
		}
	}
	throw new Error(
		"Could not find anvil-state.json. Set ANVIL_STATE_PATH or ensure " +
			"byos-service/offline-mode/state/anvil-state.json exists. " +
			"Run `git submodule update --init` in the Rust repo.",
	);
}

/**
 * Strip transaction history from the anvil state file so that any recent
 * anvil version can load it. Mirrors `stripped_state()` in chain.rs.
 */
function strippedState(statePath: string): string {
	const raw = readFileSync(statePath, "utf8");
	const state = JSON.parse(raw);

	delete state.transactions;
	delete state.historical_states;

	if (Array.isArray(state.blocks)) {
		for (const block of state.blocks) {
			if (block && typeof block === "object") {
				block.transactions = [];
			}
		}
	}

	const dir = mkdtempSync(join(tmpdir(), "byos-onchain-"));
	const out = join(dir, "anvil-state.json");
	writeFileSync(out, JSON.stringify(state));
	return out;
}

/**
 * Spawn an Anvil instance on a random port with the offline-mode state loaded.
 * Returns the RPC URL and a cleanup function.
 */
async function spawnAnvil(statePath: string): Promise<{
	rpcUrl: string;
	accounts: Address[];
	keys: Hex[];
	cleanup: () => void;
}> {
	const { spawn } = await import("node:child_process");
	const net = await import("node:net");

	// Find a free port
	const port = await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				const p = addr.port;
				server.close(() => resolve(p));
			} else {
				reject(new Error("Could not determine free port"));
			}
		});
	});

	const strippedPath = strippedState(statePath);

	const anvil = spawn("anvil", ["--port", String(port), "--load-state", strippedPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Wait for anvil to be ready
	const rpcUrl = `http://127.0.0.1:${port}`;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Anvil did not start within 15s")), 15000);
		let output = "";

		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("Listening on")) {
				clearTimeout(timeout);
				resolve();
			}
		};

		anvil.stdout?.on("data", onData);
		anvil.stderr?.on("data", onData);

		anvil.on("error", (err) => {
			clearTimeout(timeout);
			reject(new Error(`Failed to spawn anvil: ${err.message}. Is foundry installed?`));
		});

		anvil.on("exit", (code) => {
			clearTimeout(timeout);
			if (code !== null && code !== 0) {
				reject(new Error(`Anvil exited with code ${code}. Output:\n${output}`));
			}
		});
	});

	// Standard anvil accounts (same as Rust's anvil.keys()/anvil.addresses())
	const accounts: Address[] = [
		"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
		"0x90F79bf6EB2c4f870365E785982E1f101E93b906",
		"0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
		"0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
		"0x976EA74026E726554dB657fA54763abd0C3a0aa9",
		"0x14dC79964da2C08dda4cC33B00C86d3c43564e99",
		"0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
		"0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
	];

	const keys: Hex[] = [
		"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
		"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		"0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
		"0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
		"0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
		"0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
		"0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
		"0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
		"0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
		"0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
	];

	const cleanup = () => {
		anvil.kill("SIGTERM");
		try {
			rmSync(strippedPath);
			// Also remove parent temp dir
			rmSync(join(strippedPath, ".."), { recursive: true, force: true });
		} catch {
			// best effort
		}
	};

	return { rpcUrl, accounts, keys, cleanup };
}

// ---------------------------------------------------------------------------
// Contract deployment
// ---------------------------------------------------------------------------

/**
 * Load the Escrow creation bytecode from the vendored artifact.
 */
function loadEscrowBytecode(): Hex {
	const artifactPath = join(__dirname, "../artifacts/Escrow.json");
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
	if (!bytecode || typeof bytecode !== "string") {
		throw new Error("Escrow artifact does not contain bytecode");
	}
	return bytecode as Hex;
}

/**
 * Deploy the Escrow via the CREATE2 singleton factory, mirroring
 * `deploy_escrow()` in chain.rs. Idempotent: if the contract already
 * exists at the deterministic address, returns it without transacting.
 */
async function deployEscrow(
	rpcUrl: string,
	deployer: { account: Address; key: Hex },
	roles: {
		admin: Address;
		operator: Address;
		submitters: Address[];
	},
): Promise<{ escrow: Address; trampolineFactory: Address }> {
	const publicClient = createPublicClient({
		chain: foundry,
		transport: http(rpcUrl),
	});

	const walletClient = createWalletClient({
		chain: foundry,
		transport: http(rpcUrl),
		account: deployer.account,
		key: deployer.key,
	});

	const bytecode = loadEscrowBytecode();

	// Encode constructor arguments matching the Rust fixture:
	//   _adminTransferDelay: 2 days (in seconds)
	//   _admin, _operator, _submitters, _cooldownPeriod: 1 day
	//   _settlement: GPV2_SETTLEMENT
	//   _name: "BYOS Escrow", _symbol: "BYOS"
	const constructorArgs = encodeAbiParameters(
		[
			{ type: "uint48" },
			{ type: "address" },
			{ type: "address" },
			{ type: "address[]" },
			{ type: "uint256" },
			{ type: "address" },
			{ type: "string" },
			{ type: "string" },
		],
		[
			2 * 24 * 60 * 60, // _adminTransferDelay
			roles.admin,
			roles.operator,
			roles.submitters,
			BigInt(24 * 60 * 60), // _cooldownPeriod
			GPV2_SETTLEMENT,
			"BYOS Escrow",
			"BYOS",
		],
	);

	const initCode = concat([bytecode, constructorArgs]);
	const salt = pad("0x00", { size: 32 });

	// Compute the CREATE2 address
	const escrow = getContractAddress({
		bytecode: initCode,
		from: CREATE2_FACTORY,
		opcode: "CREATE2",
		salt,
	});

	// Check if already deployed
	const existing = await publicClient.getCode({ address: escrow });
	if (existing && existing !== "0x") {
		// Already deployed, read the TrampolineFactory
		const trampolineFactory = await publicClient.readContract({
			address: escrow,
			abi: [
				{
					type: "function",
					name: "TRAMPOLINE_FACTORY",
					inputs: [],
					outputs: [{ type: "address" }],
					stateMutability: "view",
				},
			],
			functionName: "TRAMPOLINE_FACTORY",
		});
		return { escrow, trampolineFactory: trampolineFactory as Address };
	}

	// Deploy: the singleton factory takes `salt ++ init_code` as raw calldata
	const calldata = concat([salt, initCode]);

	const hash = await walletClient.sendTransaction({
		to: CREATE2_FACTORY,
		data: calldata as Hex,
	});

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (receipt.status !== "success") {
		throw new Error("Escrow CREATE2 deployment reverted");
	}

	// Read back the TrampolineFactory address
	const trampolineFactory = await publicClient.readContract({
		address: escrow,
		abi: [
			{
				type: "function",
				name: "TRAMPOLINE_FACTORY",
				inputs: [],
				outputs: [{ type: "address" }],
				stateMutability: "view",
			},
		],
		functionName: "TRAMPOLINE_FACTORY",
	});

	return { escrow, trampolineFactory: trampolineFactory as Address };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Boot the full chain fixture: spawn Anvil with the offline-mode state,
 * then deploy the Escrow (which deploys the TrampolineFactory).
 *
 * Mirrors `Chain::spawn()` in crates/e2e/src/chain.rs.
 */
export async function spawnChain(): Promise<ChainFixture> {
	const statePath = resolveStatePath();
	const { rpcUrl, accounts, keys, cleanup: killAnvil } = await spawnAnvil(statePath);

	// Deploy Escrow with the same role mapping as the Rust fixture:
	//   admin = accounts[2], operator = accounts[1], submitters = [accounts[0]]
	// biome-ignore lint/style/noNonNullAssertion: anvil accounts array is always 10 elements
	const deployer = { account: accounts[0]!, key: keys[0]! };
	const { escrow, trampolineFactory } = await deployEscrow(rpcUrl, deployer, {
		// biome-ignore lint/style/noNonNullAssertion: anvil accounts array is always 10 elements
		admin: accounts[2]!,
		// biome-ignore lint/style/noNonNullAssertion: anvil accounts array is always 10 elements
		operator: accounts[1]!,
		// biome-ignore lint/style/noNonNullAssertion: anvil accounts array is always 10 elements
		submitters: [accounts[0]!],
	});

	return {
		rpcUrl,
		escrow,
		trampolineFactory,
		accounts,
		keys,
		cleanup: killAnvil,
	};
}
