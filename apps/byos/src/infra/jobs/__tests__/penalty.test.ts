import { describe, expect, it } from "vitest";
import { nonSettlementReason } from "../penalty.js";

describe("nonSettlementReason", () => {
	it("hashes the raw order UID bytes, matching the Rust service", () => {
		const orderUid = `0x${"ab".repeat(56)}`;

		// keccak256 of the 56 UID bytes — alloy's keccak256(order_uid.0).
		// Hashing the hex *string* instead (114 ASCII bytes) gives
		// 0xf017b7a76c1623a1bc508e01b7a76330bcc718ebb07bfe044fd5560a3a8c1977.
		expect(nonSettlementReason(orderUid)).toBe(
			"0x811aefaa9109cb13958f9ed814ed54293a62572f99c04c78daa1b4516ff416d0",
		);
	});
});
