import { describe, expect, it } from "vitest";
import {
	directAssetIconUrls,
	providerIconUrls,
	symbolIconUrls,
} from "#/components/crypto-icons/resolver";

describe("crypto icon resolver", () => {
	it.each([
		["APT", "blockchains/aptos/info/logo.png"],
		["ETH", "blockchains/ethereum/info/logo.png"],
		["MATIC", "blockchains/polygon/info/logo.png"],
		["POL", "blockchains/polygon/info/logo.png"],
		["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
		["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
		["TRX", "blockchains/tron/info/logo.png"],
	] as const)("uses a currency logo for external %s assets", (symbol, path) => {
		const urls = symbolIconUrls(symbol);
		expect(urls).toHaveLength(4);
		expect(urls.every((url) => url.includes(path))).toBe(true);
	});

	it("uses the bundled X Layer network icon", () => {
		expect(directAssetIconUrls({ network: "xlayer" })).toEqual([
			"/icons/xlayer.svg",
		]);
	});

	it("does not substitute a platform logo for an unknown currency", () => {
		expect(symbolIconUrls("UNKNOWN")).toEqual([]);
	});

	it("does not render a network logo in place of a currency logo", () => {
		const currency = directAssetIconUrls({
			network: "tron",
			symbol: "USDT",
		});
		expect(currency).toHaveLength(4);
		expect(currency.every((url) => !url.includes("/tron/info/logo.png"))).toBe(
			true,
		);
		expect(directAssetIconUrls({ network: "tron" })).toEqual(
			expect.arrayContaining([expect.stringContaining("/tron/info/logo.png")]),
		);
	});

	it("uses a chain-specific token contract when one is available", () => {
		const currency = directAssetIconUrls({
			contractAddress: "TXYZ-token-contract",
			network: "tron",
			symbol: "USDT",
		});
		expect(currency).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"/blockchains/tron/assets/TXYZ-token-contract/logo.png",
				),
			]),
		);
	});

	it.each([
		["exchange", "binance", "/support/exchanges/binance/logo.svg"],
		["exchange", "okx", "/support/exchanges/okx/logo.svg"],
		["wallet", "okpay", "/support/wallets/okpay/logo.svg"],
	] as const)("resolves %s provider logos", (kind, provider, path) => {
		const urls = providerIconUrls(kind, provider);
		expect(urls).toHaveLength(4);
		expect(urls.every((url) => url.includes(path))).toBe(true);
	});
});
