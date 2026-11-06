import { describe, expect, it } from "vitest";
import { statusFromPayment } from "#/features/orders/state-machine";
import {
	autoApprovalApplies,
	autoApprovalPolicy,
	couldOwnTransfer,
	settlesAutomatically,
	underpaymentToleranceFor,
	withinAutoApprovalWindow,
} from "#/features/payments/server/auto-approval";
import { reconcileOrderPayment } from "#/features/payments/server/reconciliation";

const order = {
	created_at: autoApprovalPolicy.ordersCreatedFromMs,
	expires_at: autoApprovalPolicy.ordersCreatedFromMs + 1_800_000,
	amount_minor: "320000",
	currency: "CNY",
	asset_code: "USDT",
	decimals: 6,
	expected_amount_units: "485035300",
	rail_kind: "chain",
	rail_code: "tron",
	contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
};

describe("automatic approval policy", () => {
	it("covers only new CNY orders up to ¥3300 paid in official on-chain USDT", () => {
		expect(autoApprovalApplies(order)).toBe(true);
		expect(autoApprovalApplies({ ...order, amount_minor: "330000" })).toBe(
			true,
		);
		expect(autoApprovalApplies({ ...order, amount_minor: "330001" })).toBe(
			false,
		);
		expect(autoApprovalApplies({ ...order, amount_minor: "0" })).toBe(false);
		expect(autoApprovalApplies({ ...order, amount_minor: "1e5" })).toBe(false);
		expect(autoApprovalApplies({ ...order, currency: "USD" })).toBe(false);
		expect(autoApprovalApplies({ ...order, asset_code: "USDC" })).toBe(false);
		expect(
			autoApprovalApplies({ ...order, created_at: order.created_at - 1 }),
		).toBe(false);
	});

	it("excludes exchange ledgers, unknown chains and look-alike contracts", () => {
		expect(
			autoApprovalApplies({
				...order,
				rail_kind: "exchange",
				rail_code: "binance",
				contract_address: null,
				decimals: 8,
			}),
		).toBe(false);
		expect(
			autoApprovalApplies({
				...order,
				rail_code: "xlayer",
				contract_address: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
			}),
		).toBe(false);
		expect(
			autoApprovalApplies({
				...order,
				contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6T",
			}),
		).toBe(false);
		expect(
			autoApprovalApplies({
				...order,
				rail_code: "bsc",
				decimals: 18,
				expected_amount_units: "17428100000000000000",
				contract_address: "0x55D398326F99059FF775485246999027B3197955",
			}),
		).toBe(true);
	});

	it("never applies to orders below one USDT", () => {
		expect(
			autoApprovalApplies({ ...order, expected_amount_units: "999999" }),
		).toBe(false);
		expect(
			autoApprovalApplies({ ...order, expected_amount_units: "1000000" }),
		).toBe(true);
	});

	it("tolerates exactly 0.1 USDT short, in each chain's precision", () => {
		expect(underpaymentToleranceFor(6)).toBe(100_000n);
		expect(underpaymentToleranceFor(18)).toBe(10n ** 17n);
		expect(settlesAutomatically(order, 17_428_100n, 17_328_100n)).toBe(true);
		expect(settlesAutomatically(order, 17_428_100n, 17_328_099n)).toBe(false);
	});

	it("accepts an overpayment up to 5 %", () => {
		expect(settlesAutomatically(order, 100_000_000n, 105_000_000n)).toBe(true);
		expect(settlesAutomatically(order, 100_000_000n, 105_000_001n)).toBe(false);
		expect(couldOwnTransfer(6, 0n, 1n)).toBe(false);
		expect(couldOwnTransfer(6, 1n, 0n)).toBe(false);
	});

	it("bounds the late window to six hours after expiry", () => {
		expect(withinAutoApprovalWindow(order, order.created_at - 1)).toBe(false);
		expect(
			withinAutoApprovalWindow(order, order.expires_at + 6 * 3_600_000),
		).toBe(true);
		expect(
			withinAutoApprovalWindow(order, order.expires_at + 6 * 3_600_000 + 1),
		).toBe(false);
	});

	it("keeps the default state machine unchanged without a tolerance", () => {
		expect(statusFromPayment(100n, 99n, 20, 20)).toBe("partially_paid");
		expect(statusFromPayment(100n, 99n, 20, 20, 1n)).toBe("paid");
		expect(statusFromPayment(100n, 99n, 5, 20, 1n)).toBe("confirming");
		expect(statusFromPayment(100n, 101n, 20, 20, 1n)).toBe("overpaid");
	});

	it("never treats an unconfirmed transfer as settled", () => {
		for (const expectedUnits of [50_000n, 100_000n, 150_000n])
			expect(
				reconcileOrderPayment({
					expectedUnits,
					requiredConfirmations: 20,
					underpaymentToleranceUnits: 100_000n,
					payments: [{ amountUnits: 1n, confirmations: 0, status: "detected" }],
				}).status,
			).not.toBe("paid");
	});
});
