import { decodeFunctionData, keccak256, toHex } from "viem";
import { expect, it } from "vitest";
import { FlashLoanRouterAbi } from "../abis/flash-loan-router.js";
import { flashLoanWrapper } from "../flash-loan.js";

it("encodes the upstream Loan.Data ABI and preserves settlement calldata", () => {
	const hint = {
		liquidityProvider: "0x1111111111111111111111111111111111111111",
		protocolAdapter: "0x2222222222222222222222222222222222222222",
		receiver: "0x3333333333333333333333333333333333333333",
		token: "0x4444444444444444444444444444444444444444",
		amount: 2n ** 200n,
	} as const;
	const router = "0x5555555555555555555555555555555555555555";
	const wrapper = flashLoanWrapper(hint, router);
	const calldata = wrapper.encode("0x12345678abcdef");
	// Independent upstream signature: uint256 amount, address borrower, lender, token.
	expect(calldata.slice(0, 10)).toBe(
		keccak256(toHex("flashLoanAndSettle((uint256,address,address,address)[],bytes)")).slice(0, 10),
	);
	expect(wrapper.address).toBe(router);
	const decoded = decodeFunctionData({ abi: FlashLoanRouterAbi, data: calldata });
	expect(decoded.args).toEqual([
		[
			{
				amount: hint.amount,
				borrower: hint.protocolAdapter,
				lender: hint.liquidityProvider,
				token: hint.token,
			},
		],
		"0x12345678abcdef",
	]);
});
