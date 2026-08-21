import { OrderKind, SigningScheme } from "@byos/common";
import { describe, expect, it } from "vitest";
import { buildSimulation, DUMMY_SUBMITTER } from "../simulation.js";

const ESCROW = "0x00000000000000000000000000000000000000ee";
const AUTHENTICATOR = "0x3333333333333333333333333333333333331234";

describe("simulation state overrides", () => {
	it("submitter role slot matches forge computation", () => {
		// Pinned against `cast keccak` over the same concatenations; the Rust
		// original verified the formula on a mainnet fork (vm.store at this
		// slot made hasRole(SUBMITTER_ROLE, DUMMY_SUBMITTER) pass).
		const sim = buildSimulation({
			settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
			authenticator: AUTHENTICATOR,
			escrow: ESCROW,
			trampoline: "0x4444444444444444444444444444444444441234",
			order: {
				sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
				buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
				receiver: "0x0000000000000000000000000000000000000000",
				sellAmount: 1_000_000n,
				buyAmount: 990_000n,
				validTo: 1_700_000_000,
				appData: `0x${"00".repeat(32)}`,
				feeAmount: 0n,
				kind: OrderKind.SELL,
				partiallyFillable: false,
				signingScheme: SigningScheme.Eip712,
				signature: `0x${"ab".repeat(65)}`,
			},
			proposal: {
				orderUidHash: `0x${"cc".repeat(32)}`,
				sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
				buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
				sellAmount: 1_000_000n,
				minBuyAmount: 990_000n,
				quoteBuyAmount: 990_000n,
				validUntil: 1_700_000_000n,
				nonce: 1n,
			},
			route: [],
			signature: `0x${"ee".repeat(65)}`,
			preInteractions: [],
			postInteractions: [],
		});

		const escrowOverride = sim.stateOverride.find((o) => o.address === ESCROW);
		expect(escrowOverride?.stateDiff).toEqual([
			{
				slot: "0x4eb8c5e0e8f6947fc61867e46604b89f6f2511c7f24d1be62be922d32b056655",
				value: `0x${"00".repeat(31)}01`,
			},
		]);

		// The other override injects AnyoneAuthenticator code at the
		// authenticator address so isSolver() passes for the dummy submitter.
		expect(DUMMY_SUBMITTER).toBe("0x1111111111111111111111111111111111111111");
		const authOverride = sim.stateOverride.find((o) => o.address === AUTHENTICATOR);
		expect(authOverride?.code).toMatch(/^0x6080/);
	});
});
