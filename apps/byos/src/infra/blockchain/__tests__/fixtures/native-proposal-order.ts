import { auctionOrderSchema } from "../../../api/types.js";
// Public order from the native-proposal TokenMismatch incident on 2026-11-03.
export const nativeProposalAuctionOrder = auctionOrderSchema.parse({
	uid: "0x2f8c46603b27c6a64cb87f6cd59fad04be7b794bb4b8d72157e15efb14bf20f30b3565016567fb4b088e258c584e7471b28470d16af3462f",
	sellToken: "0x29cfbc20f999e7fc35834526786021633bc2ad85",
	buyToken: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
	receiver: "0x0b3565016567fb4b088e258c584e7471b28470d1",
	owner: "0x0b3565016567fb4b088e258c584e7471b28470d1",
	sellAmount: "3871655457067945432",
	fullSellAmount: "3871655457067945432",
	buyAmount: "27577505838975645",
	fullBuyAmount: "27577505838975645",
	validTo: 1794328111,
	appData: "0x75cd9eb72b5c5424bcded4cc1b5aec9a34c227fc2b80a2429fe2f14f11b28ee5",
	kind: "sell",
	partiallyFillable: true,
	signingScheme: "eip712",
	signature:
		"0x909bcdef00e1a74fcdb1d5228268df0da5f445411d0f2bfc229ea498aff5ffd574ff8a3dd8c5b50f5e080b74201c5e567db39a18481aab624b9bfe119c8ff2941c",
	sellTokenSource: "erc20",
	buyTokenDestination: "erc20",
	class: "limit",
	preInteractions: [],
	postInteractions: [],
});
