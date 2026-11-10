import { BUY_ETH_ADDRESS } from "@byos/common";
import type { Address } from "viem";

/** Shared underlying exposure, not 1:1 parity or a guarantee of liquidity. */
export const CORRELATED_ASSETS: Readonly<Partial<Record<number, readonly (readonly Address[])[]>>> =
	{
		56: [
			// ETH: Binance-Peg ETH, WBETH, wstETH.
			// https://docs.lido.fi/deployed-contracts/
			// https://www.binance.com/en-IN/support/faq/detail/e252366155174ba6887f6b32e3798273
			[
				"0x2170ed0880ac9a755fd29b2688956bd959f933f8",
				"0xa2e3356610840701bdf5611a53974510ae27e2e1",
				"0x26c5e01524d2e6280a48f2c50ff6de7e52e9611c",
			],
			// USD: USDT/BSC-USD, USDC, FDUSD, USD1, DAI, axlUSDC, USDe, USDD, USDF.
			// https://www.firstdigitallabs.com/fdusd
			// https://docs.ethena.fi/technical-design/key-addresses
			// https://docs.usdd.io/developers/deployment-addresses
			// https://docs.asterdex.com/overview/smart-contracts
			[
				"0x55d398326f99059ff775485246999027b3197955",
				"0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
				"0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
				"0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
				"0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3",
				"0x4268b8f0b87b6eae5d897996e6b845ddbd99adf3",
				"0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
				"0x45e51bc23d592eb2dba86da3985299f7895d66ba",
				"0x5a110fc00474038f6c02e89c707d638602ea44b5",
			],
			// EUR: EURI, EURAU.
			// https://www.bpn.finance/stable-coins
			// https://allunity.com/eurau
			["0x9d1a7a3191102e9f900faa10540837ba84dcbae7", "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2"],
			// BTC: BTCB, base SolvBTC, LayerZero WBTC, LBTC.
			// https://docs.solv.finance/developer-guide/contracts
			// https://openapi.wbtc.network/public/v1/chains
			// https://docs.lombard.finance/learn/transparency/smart-contracts
			[
				"0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
				"0x4aae823a6a0b376de6a78e74ecc5b079d38cbcf7",
				"0x0555e30da8f98308edb960aa94c0db47230d2b9c",
				"0xecac9c5f704e954931349da37f60e39f515c11c1",
			],
			// BNB: native sentinel, WBNB, slisBNB, ankrBNB, asBNB.
			// https://docs.bsc.lista.org/user-guide/liquid-staking-slisbnb/mint-slisbnb
			// https://www.ankr.com/docs/staking-extra/staking-smart-contracts/
			// https://docs.asterdex.com/overview/smart-contracts
			[
				BUY_ETH_ADDRESS,
				"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
				"0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b",
				"0x52f24a5e03aee338da5fd9df68d2b6fae1178827",
				"0x77734e70b6e88b4d82fe632a168edf6e700912b6",
			],
		],
	};
