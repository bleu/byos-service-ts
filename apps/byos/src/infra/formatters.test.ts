import { describe, expect, it } from "vitest";
import {
	blockExplorerAddressUrl,
	blockExplorerTxUrl,
	cowExplorerOrderUrl,
	formatNativeAmount,
	slackAddress,
	slackAmount,
	slackLink,
	slackOrderUid,
	slackTx,
	tenderlyTxUrl,
	txLinks,
} from "./formatters.js";

const MAINNET = 1;
const GNOSIS = 100;
const SEPOLIA = 11155111;
const UNKNOWN_CHAIN = 99999;

const SAMPLE_ADDRESS = "0xe05fcc23807536bee418f142d19fa0d21bb0cff7";
const SAMPLE_TX = `0x${"aa".repeat(32)}`;
const SAMPLE_ORDER_UID = `0x${"bb".repeat(56)}`;

describe("cowExplorerOrderUrl", () => {
	it("returns full URL when cowExplorerUrl is set", () => {
		const url = cowExplorerOrderUrl(SAMPLE_ORDER_UID, "https://explorer.cow.fi");
		expect(url).toBe(`https://explorer.cow.fi/orders/${SAMPLE_ORDER_UID}`);
	});

	it("returns null when cowExplorerUrl is empty string", () => {
		expect(cowExplorerOrderUrl(SAMPLE_ORDER_UID, "")).toBeNull();
	});
});

describe("blockExplorerAddressUrl", () => {
	it("returns etherscan URL for mainnet", () => {
		const url = blockExplorerAddressUrl(SAMPLE_ADDRESS, MAINNET);
		expect(url).toContain("etherscan.io");
		expect(url).toContain(SAMPLE_ADDRESS);
	});

	it("returns gnosisscan URL for gnosis", () => {
		const url = blockExplorerAddressUrl(SAMPLE_ADDRESS, GNOSIS);
		expect(url).toContain(SAMPLE_ADDRESS);
		expect(url).not.toBeNull();
	});

	it("returns null for unknown chain", () => {
		expect(blockExplorerAddressUrl(SAMPLE_ADDRESS, UNKNOWN_CHAIN)).toBeNull();
	});
});

describe("blockExplorerTxUrl", () => {
	it("returns etherscan tx URL for mainnet", () => {
		const url = blockExplorerTxUrl(SAMPLE_TX, MAINNET);
		expect(url).toContain("etherscan.io");
		expect(url).toContain(SAMPLE_TX);
	});

	it("returns null for unknown chain", () => {
		expect(blockExplorerTxUrl(SAMPLE_TX, UNKNOWN_CHAIN)).toBeNull();
	});
});

describe("tenderlyTxUrl", () => {
	it("returns tenderly URL for mainnet", () => {
		const url = tenderlyTxUrl(SAMPLE_TX, MAINNET);
		expect(url).toBe(`https://dashboard.tenderly.co/tx/mainnet/${SAMPLE_TX}`);
	});

	it("returns tenderly URL for gnosis", () => {
		const url = tenderlyTxUrl(SAMPLE_TX, GNOSIS);
		expect(url).toBe(`https://dashboard.tenderly.co/tx/gnosis/${SAMPLE_TX}`);
	});

	it("returns tenderly URL for sepolia", () => {
		const url = tenderlyTxUrl(SAMPLE_TX, SEPOLIA);
		expect(url).toBe(`https://dashboard.tenderly.co/tx/sepolia/${SAMPLE_TX}`);
	});

	it("returns null for chain not in Tenderly map", () => {
		expect(tenderlyTxUrl(SAMPLE_TX, UNKNOWN_CHAIN)).toBeNull();
	});
});

describe("formatNativeAmount", () => {
	it("formats ETH on mainnet", () => {
		expect(formatNativeAmount(10_000_000_000_000_000n, MAINNET)).toBe("0.01 ETH");
	});

	it("formats XDAI on gnosis", () => {
		expect(formatNativeAmount(1_000_000_000_000_000_000n, GNOSIS)).toBe("1 XDAI");
	});

	it("accepts string bigint input", () => {
		expect(formatNativeAmount("1000000000000000000", MAINNET)).toBe("1 ETH");
	});

	it("falls back to ETH symbol for unknown chain", () => {
		expect(formatNativeAmount(1_000_000_000_000_000_000n, UNKNOWN_CHAIN)).toContain("ETH");
	});
});

describe("slackLink", () => {
	it("renders mrkdwn link when url is provided", () => {
		expect(slackLink("https://example.com", "label")).toBe("<https://example.com|label>");
	});

	it("falls back to plain label when url is null", () => {
		expect(slackLink(null, "label")).toBe("label");
	});

	it("falls back to plain label when url is undefined", () => {
		expect(slackLink(undefined, "label")).toBe("label");
	});
});

describe("Slack formatter helpers — graceful fallback on unknown chain", () => {
	const unknownCtx = { chainId: UNKNOWN_CHAIN, cowExplorerUrl: "https://explorer.cow.fi" };

	it("slackAddress falls back to plain address", () => {
		const result = slackAddress(SAMPLE_ADDRESS, unknownCtx);
		expect(result).toBe(SAMPLE_ADDRESS);
	});

	it("slackTx falls back to plain hash", () => {
		const result = slackTx(SAMPLE_TX, unknownCtx);
		expect(result).toBe(SAMPLE_TX);
	});

	it("slackOrderUid uses CoW Explorer link (chain-agnostic) with full uid", () => {
		const result = slackOrderUid(SAMPLE_ORDER_UID, unknownCtx);
		expect(result).toContain("explorer.cow.fi");
		expect(result).toContain(SAMPLE_ORDER_UID);
	});

	it("slackAmount does not throw on unknown chain", () => {
		expect(() => slackAmount(1_000_000_000_000_000_000n, unknownCtx)).not.toThrow();
	});
});

describe("txLinks", () => {
	it("returns both URLs when tx hash and chain are known", () => {
		const links = txLinks(SAMPLE_TX, MAINNET);
		expect(links.explorerUrl).toContain("etherscan.io");
		expect(links.tenderlyUrl).toContain("tenderly.co");
	});

	it("returns nulls when tx hash is null", () => {
		const links = txLinks(null, MAINNET);
		expect(links.explorerUrl).toBeNull();
		expect(links.tenderlyUrl).toBeNull();
	});

	it("returns null tenderlyUrl for chain not in Tenderly map", () => {
		const links = txLinks(SAMPLE_TX, UNKNOWN_CHAIN);
		expect(links.explorerUrl).toBeNull();
		expect(links.tenderlyUrl).toBeNull();
	});
});
