import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACTS } from "../config.js";
import { E2E_FIXTURES } from "../fixtures.js";
import { assertE2ePrerequisites, seedE2ePrerequisites } from "../prerequisites.js";

const mocks = vi.hoisted(() => ({
	readContract: vi.fn(),
	getCode: vi.fn(),
	depositToEscrow: vi.fn(),
	ensureTrampolineDeployed: vi.fn(),
	fundToken: vi.fn(),
	approveVaultRelayer: vi.fn(),
}));
vi.mock("../clients.js", () => ({
	anvilMainnet: undefined,
	publicClient: { readContract: mocks.readContract, getCode: mocks.getCode },
	deployerWallet: {},
	subSolverWallet: {},
	traderWallet: {},
}));
vi.mock("../orderbook.js", () => ({
	depositToEscrow: mocks.depositToEscrow,
	ensureTrampolineDeployed: mocks.ensureTrampolineDeployed,
	fundToken: mocks.fundToken,
	approveVaultRelayer: mocks.approveVaultRelayer,
}));

let balances: { escrow: bigint; usdc: bigint; weth: bigint; allowance: bigint; code: string };
beforeEach(() => {
	vi.resetAllMocks();
	balances = {
		escrow: 2n * 10n ** 18n,
		usdc: 20_000_000_000n,
		weth: 3n * 10n ** 18n,
		allowance: 2n ** 256n - 1n,
		code: "0x1234",
	};
	mocks.readContract.mockImplementation(
		async ({ functionName, address }: { functionName: string; address: string }) => {
			if (functionName === "effectiveBalance") return balances.escrow;
			if (functionName === "addressOf") return CONTRACTS.trampolineFactory;
			if (functionName === "allowance") return balances.allowance;
			if (functionName === "balanceOf")
				return address === CONTRACTS.usdc ? balances.usdc : balances.weth;
			throw new Error(`Unexpected read: ${functionName}`);
		},
	);
	mocks.getCode.mockImplementation(async () => balances.code);
});

function expectNoTransactions() {
	for (const send of [
		mocks.depositToEscrow,
		mocks.ensureTrampolineDeployed,
		mocks.fundToken,
		mocks.approveVaultRelayer,
	])
		expect(send).not.toHaveBeenCalled();
}

describe("seeded e2e prerequisites", () => {
	it("does not send transactions when the seed is already present", async () => {
		await seedE2ePrerequisites();
		expectNoTransactions();
	});
	it("tops up only missing balances and creates missing approvals and Trampoline", async () => {
		balances = {
			escrow: 1n * 10n ** 18n,
			usdc: 1_000_000_000n,
			weth: 1n * 10n ** 18n,
			allowance: 0n,
			code: "0x",
		};
		mocks.depositToEscrow.mockImplementation(async (_wallet, _client, _address, amount: bigint) => {
			balances.escrow += amount;
		});
		mocks.fundToken.mockImplementation(
			async (_wallet, _client, token: string, _address, amount: bigint) => {
				if (token === CONTRACTS.usdc) balances.usdc += amount;
				else balances.weth += amount;
			},
		);
		mocks.ensureTrampolineDeployed.mockImplementation(async () => {
			balances.code = "0x1234";
		});
		mocks.approveVaultRelayer.mockImplementation(async () => {
			balances.allowance = 2n ** 256n - 1n;
		});
		await seedE2ePrerequisites();
		expect(mocks.depositToEscrow.mock.calls[0]?.[3]).toBe(1n * 10n ** 18n);
		expect(mocks.fundToken.mock.calls.map((args) => args[4])).toEqual([
			19_000_000_000n,
			2n * 10n ** 18n,
		]);
		expect(mocks.approveVaultRelayer).toHaveBeenCalledTimes(2);
		expect(mocks.ensureTrampolineDeployed).toHaveBeenCalledOnce();
	});
	it("preflights consumed but sufficient balances without replenishing them", async () => {
		balances.usdc = 3_000_000_000n;
		await assertE2ePrerequisites();
		expectNoTransactions();
	});
	it("keeps the permit trader unapproved and rejects pre-existing allowance", async () => {
		balances.allowance = 0n;
		await seedE2ePrerequisites(E2E_FIXTURES.hooks);
		expectNoTransactions();
		balances.allowance = 1n;
		await expect(assertE2ePrerequisites(E2E_FIXTURES.hooks)).rejects.toThrow(
			"permit trader must start with zero USDC allowance",
		);
		expectNoTransactions();
	});

	it("reports how to restore depleted state without sending transactions", async () => {
		balances.usdc = 0n;
		await expect(assertE2ePrerequisites()).rejects.toThrow("trader USDC. Run pnpm e2e:seed");
		expectNoTransactions();
	});
});
