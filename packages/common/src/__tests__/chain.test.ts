import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { describe, expect, it } from "vitest";
import {
	evmChainFor,
	isSupportedEvmChain,
	orderbookUrlFor,
	settlementAddressFor,
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
