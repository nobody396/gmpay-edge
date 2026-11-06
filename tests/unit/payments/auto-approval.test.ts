import { describe, expect, it } from "vitest";
import { statusFromPayment } from "#/features/orders/state-machine";
import {
	autoApprovalApplies,
	autoApprovalPolicy,
	couldOwnTransfer,
	settlesAutomatically,
	underpaymentToleranceUnits,
	withinAutoApprovalWindow,
} from "#/features/payments/server/auto-approval";

const order = {
	created_at: autoApprovalPolicy.ordersCreatedFromMs,
	expires_at: autoApprovalPolicy.ordersCreatedFromMs + 1_800_000,
	amount_minor: "320000",
	currency: "CNY",
	asset_code: "USDT",
	decimals: 6,
};

describe("automatic approval policy", () => {
	it("covers only new CNY USDT orders up to ¥3300", () => {
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

	it("tolerates exactly 0.1 USDT short, in each chain's precision", () => {
		expect(underpaymentToleranceUnits(order)).toBe(100_000n);
		expect(underpaymentToleranceUnits({ ...order, decimals: 18 })).toBe(
			10n ** 17n,
		);
		expect(settlesAutomatically(order, 17_428_100n, 17_328_100n)).toBe(true);
		expect(settlesAutomatically(order, 17_428_100n, 17_328_099n)).toBe(false);
		expect(underpaymentToleranceUnits({ ...order, currency: "USD" })).toBe(0n);
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
});
