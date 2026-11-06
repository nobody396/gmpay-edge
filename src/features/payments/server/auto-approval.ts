/**
 * Owner-approved automatic settlement of USDT payments that would otherwise
 * wait for a manual review: a small overpayment, an underpayment of at most
 * 0.1 USDT, a payment that arrives shortly after the order expired, and a
 * customer-submitted transaction hash that verifies on chain.
 *
 * Every rule fails closed: an order or transfer that does not clearly qualify
 * keeps the existing manual review path. Only orders created after the policy
 * went live qualify, so reviews and transfers that already exist stay manual.
 */
export const autoApprovalPolicy = {
	/** 2026-11-06 23:30 Beijing time. Orders created earlier are never auto-approved. */
	ordersCreatedFromMs: Date.parse("2026-11-06T15:30:00Z"),
	currency: "CNY",
	/** ¥3300: just above the most expensive item sold today (¥3200). */
	maxOrderAmountMinor: 330_000n,
	assetCode: "USDT",
	/**
	 * Exchange withdrawals routinely take minutes to a few hours. Six hours
	 * stays well inside the 24 h window in which the scanner still watches an
	 * expired order and the receiving-address lock is retained.
	 */
	lateGraceMs: 6 * 3_600_000,
	/** At most 0.1 USDT short. */
	underpaymentToleranceTenths: 1n,
	/** An overpayment above 5 % is unusual enough to need a person. */
	maxOverpaymentBasisPoints: 500n,
} as const;

export type AutoApprovalOrder = {
	created_at: number;
	expires_at: number;
	amount_minor: string;
	currency: string;
	asset_code: string;
	decimals: number;
};

export function autoApprovalApplies(order: AutoApprovalOrder) {
	return (
		order.created_at >= autoApprovalPolicy.ordersCreatedFromMs &&
		order.currency === autoApprovalPolicy.currency &&
		order.asset_code === autoApprovalPolicy.assetCode &&
		Number.isInteger(order.decimals) &&
		order.decimals >= 1 &&
		/^\d+$/.test(order.amount_minor) &&
		BigInt(order.amount_minor) > 0n &&
		BigInt(order.amount_minor) <= autoApprovalPolicy.maxOrderAmountMinor
	);
}

/** Units an auto-approvable order may be short and still count as paid. */
export function underpaymentToleranceUnits(order: AutoApprovalOrder) {
	if (!autoApprovalApplies(order)) return 0n;
	return toleranceUnits(order.decimals);
}

function toleranceUnits(decimals: number) {
	return (
		autoApprovalPolicy.underpaymentToleranceTenths * 10n ** BigInt(decimals - 1)
	);
}

/** The transfer happened while the order could still be paid automatically. */
export function withinAutoApprovalWindow(
	order: AutoApprovalOrder,
	transferredAtMs: number,
) {
	return (
		transferredAtMs >= order.created_at &&
		transferredAtMs <= order.expires_at + autoApprovalPolicy.lateGraceMs
	);
}

/**
 * Whether an order with `remainingUnits` left could own a transfer of
 * `amountUnits` under the automatic amount rules (shortfall within 0.1 token,
 * overpayment within 5 %), whatever the order's own policy. More than one such
 * open order means the transfer cannot be assigned automatically.
 */
export function couldOwnTransfer(
	decimals: number,
	remainingUnits: bigint,
	amountUnits: bigint,
) {
	if (remainingUnits <= 0n || amountUnits <= 0n || decimals < 1) return false;
	if (amountUnits < remainingUnits)
		return remainingUnits - amountUnits <= toleranceUnits(decimals);
	return (
		(amountUnits - remainingUnits) * 10_000n <=
		remainingUnits * autoApprovalPolicy.maxOverpaymentBasisPoints
	);
}

/** `amountUnits` settles this order's `remainingUnits` under the automatic rules. */
export function settlesAutomatically(
	order: AutoApprovalOrder,
	remainingUnits: bigint,
	amountUnits: bigint,
) {
	return (
		autoApprovalApplies(order) &&
		couldOwnTransfer(order.decimals, remainingUnits, amountUnits)
	);
}
