import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { describe, expect, it } from "vitest";
import {
	escrowAddressFor,
	evmChainFor,
	isSupportedEvmChain,
	minCollateralFor,
	orderbookUrlFor,
	settlementAddressFor,
	trampolineFactoryFor,
} from "../chain.js";

/** Every EVM chain CoW settles on. Solana is excluded deliberately — BYOS
 * cannot operate there, so it must be rejected rather than skipped. */
const EVM_CHAIN_IDS = Object.values(SupportedChainId).filter(
	(id): id is SupportedChainId => typeof id === "number" && id !== SupportedChainId.SOLANA,
);

describe("evmChainFor", () => {
	it("covers every EVM chain CoW supports", () => {
		expect(EVM_CHAIN_IDS.length).toBeGreaterThan(0);
		for (const id of EVM_CHAIN_IDS) {
			expect(evmChainFor(id).id).toBe(id);
		}
	});

	it("fills in the fields viem requires but the sdk names differently", () => {
		// The sdk calls its display field `label`; viem requires `name`, and a
		// missing one is a type error rather than a runtime surprise.
		const chain = evmChainFor(SupportedChainId.MAINNET);
		expect(chain.name).toBeTruthy();
		expect(chain.nativeCurrency.symbol).toBeTruthy();
		expect(chain.nativeCurrency.decimals).toBe(18);
		expect(chain.rpcUrls.default.http.length).toBeGreaterThan(0);
	});

	it("gives every chain a Multicall3 address, so batched reads resolve", () => {
		// The escrow balance cache reads balances with multicall. viem needs
		// this address from the chain, or it throws before reaching the RPC.
		for (const id of EVM_CHAIN_IDS) {
			expect(evmChainFor(id).contracts?.multicall3?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		}
	});

	it("rejects Solana, which BYOS cannot settle on", () => {
		expect(() => evmChainFor(SupportedChainId.SOLANA)).toThrow(/not an EVM chain/);
	});

	it("allows anvil, so local development still boots", () => {
		// CHAIN_ID=31337 is what .env.example ships and what the offline CoW
		// stack runs on. Rejecting it would break `cp .env.example .env`.
		const local = evmChainFor(31337);
		expect(local.id).toBe(31337);
		expect(local.contracts?.multicall3?.address).toBeTruthy();
	});

	it("rejects a chain CoW does not support", () => {
		expect(() => evmChainFor(999_999)).toThrow(/not supported by CoW Protocol/);
	});

	it("reports support as a boolean for config validation", () => {
		expect(isSupportedEvmChain(SupportedChainId.MAINNET)).toBe(true);
		expect(isSupportedEvmChain(SupportedChainId.SOLANA)).toBe(false);
		expect(isSupportedEvmChain(999_999)).toBe(false);
	});
});

describe("settlementAddressFor", () => {
	it("returns the CoW settlement singleton for every EVM chain", () => {
		// The settlement contract is the same address on every EVM chain CoW
		// Protocol settles on — an immutable singleton.
		const SINGLETON = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
		for (const id of EVM_CHAIN_IDS) {
			expect(settlementAddressFor(id)).toBe(SINGLETON);
		}
	});

	it("returns the offline-mode address for anvil (31337)", () => {
		// The offline CoW stack forks mainnet so the address is the same.
		expect(settlementAddressFor(31337)).toBe("0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
	});

	it("throws for an unsupported chain", () => {
		expect(() => settlementAddressFor(999_999)).toThrow(/not supported/);
	});
});

describe("orderbookUrlFor", () => {
	it("returns a prod api.cow.fi URL for every EVM chain", () => {
		for (const id of EVM_CHAIN_IDS) {
			expect(orderbookUrlFor(id)).toMatch(/^https:\/\/api\.cow\.fi\//);
		}
	});

	it("returns the local orderbook URL for anvil (31337)", () => {
		expect(orderbookUrlFor(31337)).toBe("http://localhost:8080");
	});

	it("returns the mainnet orderbook URL for mainnet", () => {
		expect(orderbookUrlFor(SupportedChainId.MAINNET)).toBe("https://api.cow.fi/mainnet");
	});

	it("throws for an unsupported chain", () => {
		expect(() => orderbookUrlFor(999_999)).toThrow(/not supported/);
	});
});

describe("escrowAddressFor", () => {
	it("returns null for all chains (bleu contracts not yet deployed)", () => {
		// All production entries are null until bleu deploys the Escrow contract.
		// This test should be updated per chain as addresses are filled in.
		for (const id of EVM_CHAIN_IDS) {
			expect(escrowAddressFor(id)).toBeNull();
		}
	});

	it("returns null for anvil (resolved via env override in e2e/local)", () => {
		// e2e-stack.sh writes ESCROW_ADDRESS, which overrides this null.
		expect(escrowAddressFor(31337)).toBeNull();
	});

	it("throws for an unsupported chain", () => {
		expect(() => escrowAddressFor(999_999)).toThrow(/not supported/);
	});
});

describe("trampolineFactoryFor", () => {
	it("returns null for all production chains (not yet deployed)", () => {
		for (const id of EVM_CHAIN_IDS) {
			expect(trampolineFactoryFor(id)).toBeNull();
		}
	});

	it("returns the offline-mode factory address for anvil (31337)", () => {
		// The offline CoW stack deploys TrampolineFactory at this address.
		expect(trampolineFactoryFor(31337)).toBe("0x00000000000000000000000000000000000fac70");
	});

	it("throws for an unsupported chain", () => {
		expect(() => trampolineFactoryFor(999_999)).toThrow(/not supported/);
	});
});

describe("minCollateralFor", () => {
	it("gives every EVM chain a non-zero default", () => {
		// A zero floor silently disables the negative set, which is what bounds
		// the balance refresh population by capital rather than attacker effort.
		for (const id of EVM_CHAIN_IDS) {
			expect(minCollateralFor(id)).toBeGreaterThan(0n);
		}
	});

	it("covers anvil, so local development has a floor too", () => {
		expect(minCollateralFor(31337)).toBeGreaterThan(0n);
	});

	it("refuses Solana rather than defaulting it to zero", () => {
		expect(() => minCollateralFor(SupportedChainId.SOLANA)).toThrow(/does not operate/);
	});

	it("refuses a chain CoW does not support", () => {
		expect(() => minCollateralFor(999_999)).toThrow(/not supported/);
	});
});
