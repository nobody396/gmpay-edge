import { describe, expect, it } from "vitest";
import { bscWithdrawalAmount } from "#/features/checkout/bsc-withdrawal-amount";

describe("BSC withdrawal input helper", () => {
	it.each([
		["59.8613", "59.8713"],
		["1.4950", "1.5050"],
		["1.5", "1.5100"],
		["0.99999999", "1.00999999"],
		["9007199254740993.8613", "9007199254740993.8713"],
		["0.000000000000000001", "0.010000000000000001"],
	])("adds only 0.01 to %s without floating-point rounding", (amount, expected) => {
		const order = Object.freeze({
			network: "bsc",
			token: "USDT",
			actual_amount: amount,
		});
		expect(bscWithdrawalAmount(order)).toBe(expected);
		expect(order.actual_amount).toBe(amount);
	});

	it.each([
		"tron",
		"xlayer",
		"ethereum",
		"binance",
		"okpay",
		"",
	])("does not add the fee to %s", (network) =>
		expect(
			bscWithdrawalAmount({ network, token: "USDT", actual_amount: "1.5" }),
		).toBeNull());

	it.each(["BNB", "USDC", ""])("does not add the fee to %s", (token) => {
		expect(
			bscWithdrawalAmount({ network: "bsc", token, actual_amount: "1.5" }),
		).toBeNull();
	});

	it.each([
		undefined,
		"",
		"0",
		"-1",
		"NaN",
		"Infinity",
		"1e3",
		"1.2345678901234567891",
	])("fails closed for missing or invalid payment amount %s", (actual_amount) =>
		expect(
			bscWithdrawalAmount({
				network: "bsc",
				token: "USDT",
				...(actual_amount !== undefined ? { actual_amount } : {}),
			}),
		).toBeNull());
});
