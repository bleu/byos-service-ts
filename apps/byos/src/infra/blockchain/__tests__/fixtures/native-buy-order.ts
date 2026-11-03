import { auctionOrderSchema } from "../../../api/types.js";

const owner = "0x2ee9d130349c0cf9e3aeee2b2134aa6cf6506e78";
const wrappedToken = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
// Public BNB order from the 2026-11-03 signer-mismatch incident, with the
// driver normalization applied: only buyToken differs from the signed order.
export const nativeBuyAuctionOrder = auctionOrderSchema.parse({
	uid: "0xabf7ba4c4c1a6fb7c0bee010c420df093c234d04dc70e51dcce455da5454e4b72ee9d130349c0cf9e3aeee2b2134aa6cf6506e786ae9f4f0",
	sellToken: "0x55d398326f99059ff775485246999027b3197955",
	buyToken: wrappedToken,
	receiver: owner,
	owner,
	sellAmount: "1000000000000000000",
	fullSellAmount: "1000000000000000000",
	buyAmount: "1400318609184347",
	fullBuyAmount: "1400318609184347",
	validTo: 1793717488,
	appData: "0xbc420e95d57ec7df4378e1f10ea5de0c8df1ad49c8da2aab779856e61b1626ae",
	kind: "sell",
	partiallyFillable: false,
	signingScheme: "eip712",
	signature:
		"0xd596f4aac0e29290aaaf3cf974ce2586123e785d62b18111d58316fb6b0c431c109c453f6531e6431b21a3dfa916222ef05cbc0760d58f08e08291eb90bac2281c",
	sellTokenSource: "erc20",
	buyTokenDestination: "erc20",
	class: "limit",
	preInteractions: [],
	postInteractions: [],
});
