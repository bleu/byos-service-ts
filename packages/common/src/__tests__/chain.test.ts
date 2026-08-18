import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { describe, expect, it } from "vitest";
import { evmChainFor, isSupportedEvmChain, minCollateralFor } from "../chain.js";

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
