import { describe, expect, it } from "vitest";
import {
	initialChainConnections,
	initialChainRails,
	initialExchangeRails,
	initialPaymentAssets,
	initialPaymentConnections,
	initialPaymentRails,
	initialWalletRails,
} from "#/features/payment-settings/catalog";

describe("payment infrastructure catalog", () => {
	it("keeps every supported chain represented by a rail, asset and HTTP RPC", () => {
		const requiredAssets = {
			tron: ["TRX", "USDT"],
			ethereum: ["ETH", "USDT", "USDC"],
			base: ["ETH", "USDT", "USDC"],
			bsc: ["BNB", "USDT", "USDC"],
			polygon: ["MATIC", "USDT", "USDC"],
			ton: ["GRAM", "USDT"],
			aptos: ["USDT", "USDC"],
			solana: ["USDT", "USDC"],
		} as const;
		for (const [code, assets] of Object.entries(requiredAssets)) {
			expect(initialChainRails.some((rail) => rail.code === code)).toBe(true);
			expect(
				initialChainConnections.some(
					(connection) =>
						connection.network === code &&
						connection.url.startsWith("https://"),
				),
			).toBe(true);
			const catalogAssets = initialPaymentAssets
				.filter((asset) => asset.railCode === code)
				.map((asset) => asset.code);
			expect(catalogAssets).toEqual(expect.arrayContaining([...assets]));
			for (const asset of initialPaymentAssets.filter(
				(item) => item.railCode === code,
			))
				expect(asset.defaultConfirmations).toBeGreaterThan(0);
		}
	});

	it("registers provider rails and keeps their connections enabled by default", () => {
		const requiredAssets = {
			binance: ["USDT", "USDC"],
			okx: ["USDT", "USDC"],
			okpay: ["USDT", "TRX"],
		} as const;
		for (const provider of [...initialExchangeRails, ...initialWalletRails]) {
			expect(
				initialPaymentRails.some((rail) => rail.code === provider.code),
			).toBe(true);
			const connection = initialPaymentConnections.find(
				(item) => item.railCode === provider.code,
			);
			expect(connection).toMatchObject({
				enabled: true,
				endpoint: provider.apiUrl,
			});
			expect(
				initialPaymentAssets
					.filter((asset) => asset.railCode === provider.code)
					.map((asset) => asset.code),
			).toEqual(expect.arrayContaining([...requiredAssets[provider.code]]));
		}
	});

	it("keeps optional websocket RPC nodes disabled and below the HTTP priority", () => {
		for (const network of ["ethereum", "base", "bsc", "polygon"]) {
			const websocket = initialPaymentConnections.find(
				(connection) =>
					connection.type === "rpc" &&
					connection.railCode === network &&
					connection.transport === "websocket",
			);
			expect(websocket).toMatchObject({ enabled: false, priority: 200 });
		}
	});
});
