import {
	findSameTransferAttribution,
	paymentTargetAddressMatches,
} from "#/features/payments/server/attribution";
import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";

/**
 * Owner-approved automatic settlement of on-chain USDT payments that would
 * otherwise wait for a manual review: a small overpayment, an underpayment of
 * at most 0.1 USDT, a payment that arrives shortly after the order expired,
 * and a customer payment review whose transaction hash verifies on chain.
 *
 * Every rule fails closed: an order or transfer that does not clearly qualify
 * keeps the existing manual review path. Only orders created after the policy
 * went live qualify, so reviews and transfers that already exist stay manual.
 */
export const autoApprovalPolicy = {
	/** 2026-11-07 01:30 Beijing, after this went live; earlier orders stay manual. */
	ordersCreatedFromMs: Date.parse("2026-11-06T17:30:00Z"),
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
	/** Open orders on one address older than this cannot compete any more. */
	competitorHorizonMs: 24 * 3_600_000,
} as const;

/**
 * Only the official USDT contract on chains whose transfers GMPay verifies on
 * chain itself. Exchange and wallet account ledgers (Binance Pay, OKX, OKPay)
 * are not on-chain transfers and stay manual.
 */
const officialUsdtContracts: Readonly<Record<string, string>> = {
	tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
	bsc: "0x55d398326f99059ff775485246999027b3197955",
	polygon: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
	ethereum: "0xdac17f958d2ee523a2206206994597c13d831ec7",
};

export type AutoApprovalOrder = {
	created_at: number;
	expires_at: number;
	amount_minor: string;
	currency: string;
	asset_code: string;
	decimals: number;
	expected_amount_units: string;
	rail_kind: string;
	rail_code: string;
	contract_address: string | null;
};

function sameContract(rail: string, stored: string, official: string) {
	return rail === "tron"
		? stored === official
		: stored.toLowerCase() === official.toLowerCase();
}

export function autoApprovalApplies(order: AutoApprovalOrder) {
	const official = officialUsdtContracts[order.rail_code];
	return (
		order.created_at >= autoApprovalPolicy.ordersCreatedFromMs &&
		order.currency === autoApprovalPolicy.currency &&
		order.asset_code === autoApprovalPolicy.assetCode &&
		order.rail_kind === "chain" &&
		official !== undefined &&
		order.contract_address !== null &&
		sameContract(order.rail_code, order.contract_address, official) &&
		Number.isInteger(order.decimals) &&
		order.decimals >= 1 &&
		/^\d+$/.test(order.amount_minor) &&
		BigInt(order.amount_minor) > 0n &&
		BigInt(order.amount_minor) <= autoApprovalPolicy.maxOrderAmountMinor &&
		/^\d+$/.test(order.expected_amount_units) &&
		// Below one USDT the 0.1 tolerance would be a large share of the price.
		BigInt(order.expected_amount_units) >= 10n ** BigInt(order.decimals)
	);
}

/** 0.1 token in a chain's precision. */
export function underpaymentToleranceFor(decimals: number) {
	return (
		autoApprovalPolicy.underpaymentToleranceTenths * 10n ** BigInt(decimals - 1)
	);
}

/** The transfer happened while the order could still be paid automatically. */
export function withinAutoApprovalWindow(
	order: Pick<AutoApprovalOrder, "created_at" | "expires_at">,
	transferredAtMs: number,
) {
	return (
		transferredAtMs >= order.created_at &&
		transferredAtMs <= order.expires_at + autoApprovalPolicy.lateGraceMs
	);
}

/**
 * Whether an order with `remainingUnits` left could own a transfer of
 * `amountUnits`: exactly, short by at most 0.1 token, or over by at most 5 %,
 * whatever the order's own policy.
 */
export function couldOwnTransfer(
	decimals: number,
	remainingUnits: bigint,
	amountUnits: bigint,
) {
	if (remainingUnits <= 0n || amountUnits <= 0n || decimals < 1) return false;
	if (amountUnits < remainingUnits)
		return remainingUnits - amountUnits <= underpaymentToleranceFor(decimals);
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

export type AutomaticSettlementBlocker =
	| "order_not_found"
	| "out_of_scope"
	| "order_state"
	| "transfer_mismatch"
	| "transfer_not_final"
	| "outside_window"
	| "other_payments"
	| "transfer_owned_elsewhere"
	| "amount"
	| "manual_review"
	| "competing_orders";

type SettlementOrder = AutoApprovalOrder & {
	status: string;
	received_amount_units: string;
	target_value: string;
	required_confirmations: number;
};

/**
 * The single authority for automatic settlement. It reads the order, its
 * payments, its reviews and every other open order on the same receiving
 * address afresh, and returns null only when this one transfer alone settles
 * this one order under every automatic rule. Callers decide nothing else.
 */
export async function automaticSettlementBlocker(
	db: D1Database,
	input: {
		orderId: string;
		transaction: NormalizedTransaction;
		/** The pending review being decided by this call, if any. */
		reviewId?: string;
		/** Require the transfer to be final now (customer-triggered decisions). */
		requireFinal?: boolean;
	},
): Promise<AutomaticSettlementBlocker | null> {
	const { transaction } = input;
	const order = await db
		.prepare(
			`SELECT o.status, o.created_at, o.expires_at, o.amount_minor, o.currency,
			 o.received_amount_units, ops.asset_code, ops.decimals,
			 ops.expected_amount_units, ops.rail_kind, ops.rail_code,
			 ops.contract_address, ops.target_value, ops.required_confirmations
			 FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE o.id = ? LIMIT 1`,
		)
		.bind(input.orderId)
		.first<SettlementOrder>();
	if (!order) return "order_not_found";
	if (!autoApprovalApplies(order)) return "out_of_scope";
	if (
		!["pending", "confirming", "partially_paid", "expired"].includes(
			order.status,
		)
	)
		return "order_state";
	if (
		transaction.network !== order.rail_code ||
		transaction.assetCode !== order.asset_code ||
		!paymentTargetAddressMatches(transaction.to, order.target_value) ||
		transaction.amountUnits <= 0n
	)
		return "transfer_mismatch";
	if (!transaction.success || transaction.canonical === false)
		return "transfer_not_final";
	if (
		input.requireFinal &&
		transaction.confirmations < order.required_confirmations
	)
		return "transfer_not_final";
	if (!withinAutoApprovalWindow(order, transaction.timestamp.getTime()))
		return "outside_window";

	const transactionId = paymentTransactionId(transaction);
	// One transfer settles one fresh order: no earlier, held or partial payment.
	const other = await db
		.prepare(
			"SELECT 1 AS found FROM order_payments WHERE order_id = ? AND transaction_id <> ? LIMIT 1",
		)
		.bind(input.orderId, transactionId)
		.first();
	if (other) return "other_payments";
	const owner = await db
		.prepare(
			"SELECT order_id FROM order_payments WHERE transaction_id = ? AND order_id <> ? LIMIT 1",
		)
		.bind(transactionId, input.orderId)
		.first();
	const sameTransfer = await findSameTransferAttribution(db, transaction);
	if (owner || (sameTransfer && sameTransfer.order_id !== input.orderId))
		return "transfer_owned_elsewhere";
	if (
		!settlesAutomatically(
			order,
			BigInt(order.expected_amount_units),
			transaction.amountUnits,
		)
	)
		return "amount";

	// Any other open or rejected review on this order is a person's call.
	const review = await db
		.prepare(
			`SELECT 1 AS found FROM payment_reviews WHERE order_id = ?
			 AND status IN ('pending','rejected') AND id <> ? LIMIT 1`,
		)
		.bind(input.orderId, input.reviewId ?? "")
		.first();
	if (review) return "manual_review";

	// Every unpaid order on the same address that could own this amount competes,
	// regardless of release mode, locks or which order is being scanned.
	const evm = /^0x[0-9a-f]{40}$/i.test(order.target_value);
	const competitors = await db
		.prepare(
			`SELECT o.id, o.received_amount_units, ops.expected_amount_units, ops.decimals
			 FROM order_payment_snapshots ops INDEXED BY ${
					evm
						? "order_payment_snapshots_target_nocase_idx"
						: "order_payment_snapshots_target_idx"
				}
			 JOIN orders o ON o.id = ops.order_id
			 WHERE ops.rail_code = ? AND ops.asset_code = ?
			 AND ${evm ? "LOWER(ops.target_value) = LOWER(?)" : "ops.target_value = ?"}
			 AND o.id <> ?
			 AND o.status IN ('pending','confirming','partially_paid','expired','cancelled')
			 AND o.created_at <= ? AND o.expires_at >= ?
			 LIMIT 201`,
		)
		.bind(
			order.rail_code,
			order.asset_code,
			order.target_value,
			input.orderId,
			// Same-second block timestamps: a checkout in that second still competes.
			Math.floor(transaction.timestamp.getTime() / 1000) * 1000 + 999,
			transaction.timestamp.getTime() - autoApprovalPolicy.competitorHorizonMs,
		)
		.all<{
			id: string;
			received_amount_units: string;
			expected_amount_units: string;
			decimals: number;
		}>();
	if (competitors.results.length > 200) return "competing_orders";
	if (
		competitors.results.some((competitor) =>
			couldOwnTransfer(
				competitor.decimals,
				BigInt(competitor.expected_amount_units) -
					BigInt(competitor.received_amount_units),
				transaction.amountUnits,
			),
		)
	)
		return "competing_orders";
	return null;
}
