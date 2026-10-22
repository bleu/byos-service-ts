import { EscrowAbi, TrampolineFactoryAbi } from "@byos/common";
import { type Address, erc20Abi } from "viem";
import { deployerWallet, publicClient } from "./clients.js";
import { CONTRACTS } from "./config.js";
import { E2E_FIXTURES, type E2eFixture, fixtureWallet } from "./fixtures.js";
import {
	approveVaultRelayer,
	depositToEscrow,
	ensureTrampolineDeployed,
	fundToken,
} from "./orderbook.js";

const SEED_ESCROW = 2_000_000_000_000_000_000n;
// Read-only preflight floors leave room for a full order and a subsequent run.
// Seeding uses larger per-fixture targets.
const REQUIRED_USDC = 2_000_000_000n;
const REQUIRED_WETH = 1_000_000_000_000_000_000n;

function readBalance(address: Address, owner: Address) {
	return publicClient.readContract({
		address,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [owner],
	});
}

function readAllowance(address: Address, owner: Address) {
	return publicClient.readContract({
		address,
		abi: erc20Abi,
		functionName: "allowance",
		args: [owner, CONTRACTS.vaultRelayer],
	});
}

async function readPrerequisites(fixture: E2eFixture) {
	const [escrow, trampoline, usdc, weth, usdcAllowance, wethAllowance] = await Promise.all([
		publicClient.readContract({
			address: CONTRACTS.escrow,
			abi: EscrowAbi,
			functionName: "effectiveBalance",
			args: [fixture.subSolver.address],
		}),
		publicClient.readContract({
			address: CONTRACTS.trampolineFactory,
			abi: TrampolineFactoryAbi,
			functionName: "addressOf",
			args: [fixture.subSolver.address],
		}),
		readBalance(CONTRACTS.usdc, fixture.trader.address),
		readBalance(CONTRACTS.weth, fixture.trader.address),
		readAllowance(CONTRACTS.usdc, fixture.trader.address),
		readAllowance(CONTRACTS.weth, fixture.trader.address),
	]);
	return {
		escrow,
		trampoline,
		usdc,
		weth,
		usdcAllowance,
		wethAllowance,
		trampolineCode: await publicClient.getCode({ address: trampoline }),
	};
}

/** Real transactions, once at stack startup; existing funds are only topped up. */
export async function seedE2ePrerequisites(
	fixture: E2eFixture = E2E_FIXTURES.standard,
): Promise<void> {
	const state = await readPrerequisites(fixture);
	const traderWallet = fixtureWallet(fixture.trader);
	if (state.escrow < SEED_ESCROW)
		await depositToEscrow(
			deployerWallet,
			publicClient,
			fixture.subSolver.address,
			SEED_ESCROW - state.escrow,
		);
	if (!state.trampolineCode || state.trampolineCode === "0x")
		await ensureTrampolineDeployed(deployerWallet, publicClient, fixture.subSolver.address);
	if (state.usdc < fixture.seedUsdc)
		await fundToken(
			deployerWallet,
			publicClient,
			CONTRACTS.usdc,
			fixture.trader.address,
			fixture.seedUsdc - state.usdc,
		);
	if (state.weth < fixture.seedWeth)
		await fundToken(
			deployerWallet,
			publicClient,
			CONTRACTS.weth,
			fixture.trader.address,
			fixture.seedWeth - state.weth,
		);
	if (!fixture.permitOnly && state.usdcAllowance < fixture.seedUsdc)
		await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.usdc);
	if (!fixture.permitOnly && state.wethAllowance < fixture.seedWeth)
		await approveVaultRelayer(traderWallet, publicClient, CONTRACTS.weth);
	await assertE2ePrerequisites(fixture);
}

/** Read-only preflight; never add transactions to the measured test setup. */
export async function assertE2ePrerequisites(
	fixture: E2eFixture = E2E_FIXTURES.standard,
): Promise<void> {
	const state = await readPrerequisites(fixture);
	const missing = [
		fixture.permitOnly &&
			state.usdcAllowance !== 0n &&
			"permit trader must start with zero USDC allowance",
		state.escrow < 10n ** 16n && "sub-solver collateral",
		(!state.trampolineCode || state.trampolineCode === "0x") && "deployed Trampoline",
		state.usdc < REQUIRED_USDC && "trader USDC",
		fixture.seedWeth > 0n && state.weth < REQUIRED_WETH && "trader WETH",
		!fixture.permitOnly && state.usdcAllowance < REQUIRED_USDC && "USDC approval",
		!fixture.permitOnly &&
			fixture.seedWeth > 0n &&
			state.wethAllowance < REQUIRED_WETH &&
			"WETH approval",
	].filter(Boolean);
	if (missing.length)
		throw new Error(
			`Missing e2e prerequisites: ${missing.join(", ")}. Run pnpm e2e:seed (or pnpm e2e:up).`,
		);
}

/** Seed all stable identities before any test starts. No shared chain resets. */
export async function seedAllE2ePrerequisites(): Promise<void> {
	for (const [name, fixture] of Object.entries(E2E_FIXTURES)) {
		const balance = await publicClient.getBalance({ address: fixture.trader.address });
		if (balance < 10n ** 18n)
			await publicClient.request({
				method: "anvil_setBalance" as "eth_chainId",
				params: [fixture.trader.address, "0x8ac7230489e80000"] as never,
			});
		await seedE2ePrerequisites(fixture);
		console.log(`[e2e-seed] ${name} ready`);
	}
}
