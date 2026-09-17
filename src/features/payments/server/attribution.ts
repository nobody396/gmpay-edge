import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";
import { immediateReleaseModeSql } from "#/server/operational-settings";

type AttributionCandidate = {
	order_id: string;
	expected_amount_units: string;
	received_amount_units: string;
	created_at: number;
	expires_at: number;
};

function isEvmAddress(value: string) {
	return /^0x[0-9a-f]{40}$/i.test(value);
}

export type PaymentAttribution = {
	orderId: string;
	alreadyAttributed: boolean;
};

export class PaymentAttributionAmbiguousError extends DomainError {
	constructor(code = "payment_attribution_ambiguous") {
		super(code, 409, "Transaction cannot be attributed to one payment order");
		this.name = "PaymentAttributionAmbiguousError";
	}
}

export class PaymentAttributionNotFoundError extends DomainError {
	constructor() {
		super(
			"payment_attribution_not_found",
			422,
			"Transaction does not match an eligible payment order",
		);
		this.name = "PaymentAttributionNotFoundError";
	}
}

/**
 * Resolves a chain transfer before accounting so concurrent orders sharing one
 * receiving address cannot race to claim it. The persisted transaction owner is
 * authoritative; otherwise an exact remaining balance must be unique whenever
 * more than one order can receive the transfer.
 */
export async function resolvePaymentTransactionOrder(
	db: D1Database,
	transaction: NormalizedTransaction,
	preferredOrderId?: string,
	allowReviewed = false,
): Promise<PaymentAttribution> {
	const existing = await db
		.prepare(
			"SELECT order_id FROM order_payments WHERE transaction_id = ? LIMIT 1",
		)
		.bind(paymentTransactionId(transaction))
		.first<{ order_id: string }>();
	const result = async (orderId: string, alreadyAttributed: boolean) => {
		if (!allowReviewed) {
			const review = await db
				.prepare(`SELECT 1 FROM payment_reviews WHERE order_id = ?
			 AND status IN ('pending','rejected')
			 AND (transaction_hash IS NULL OR lower(transaction_hash) = lower(?)) LIMIT 1`)
				.bind(orderId, transaction.hash)
				.first();
			if (review)
				throw new PaymentAttributionAmbiguousError("payment_review_pending");
		}
		return { orderId, alreadyAttributed };
	};
	if (existing) return result(existing.order_id, true);

	const caseInsensitiveTarget = isEvmAddress(transaction.to);
	const targetPredicate = caseInsensitiveTarget
		? "LOWER(ops.target_value) = LOWER(?)"
		: "ops.target_value = ?";
	const targetIndex = caseInsensitiveTarget
		? "order_payment_snapshots_target_nocase_idx"
		: "order_payment_snapshots_target_idx";
	const candidates = await db
		.prepare(
			`SELECT DISTINCT o.id AS order_id, o.received_amount_units,
			 ops.expected_amount_units, o.created_at, o.expires_at
			 FROM order_payment_snapshots ops INDEXED BY ${targetIndex}
			 JOIN orders o ON o.id = ops.order_id
			 LEFT JOIN receiving_method_locks lock
			 ON lock.order_id = o.id
			 AND lock.receiving_method_id = ops.receiving_method_id
			 AND lock.asset_id = ops.asset_id
			 WHERE ops.rail_code = ? AND ops.asset_code = ?
			 AND ${targetPredicate}
			 AND o.status IN (
			  'pending','confirming','partially_paid','paid','overpaid','expired','cancelled'
			 )
			 AND (
			  (${immediateReleaseModeSql} = 0
			   AND lock.collision_key IS NOT NULL)
			  OR (${immediateReleaseModeSql} = 1
			   AND o.created_at <= ? AND o.expires_at >= ?)
			  OR o.id = ?
			 )
			 LIMIT 101`,
		)
		.bind(
			transaction.network,
			transaction.assetCode,
			transaction.to,
			transaction.timestamp.getTime(),
			transaction.timestamp.getTime(),
			preferredOrderId ?? "",
		)
		.all<AttributionCandidate>();
	if (candidates.results.length === 101)
		throw new PaymentAttributionAmbiguousError();

	// EVM block timestamps have second precision. Preserve same-second checkouts,
	// but never let a later checkout claim an earlier transfer.
	const observedSecondEnd =
		Math.floor(transaction.timestamp.getTime() / 1000) * 1000 + 999;
	const eligible = candidates.results.filter(
		(candidate) => candidate.created_at <= observedSecondEnd,
	);
	const exact = eligible.filter((candidate) => {
		const remainingUnits =
			BigInt(candidate.expected_amount_units) -
			BigInt(candidate.received_amount_units);
		return remainingUnits > 0n && remainingUnits === transaction.amountUnits;
	});
	if (exact.length > 1) throw new PaymentAttributionAmbiguousError();
	const [exactCandidate] = exact;
	if (exactCandidate) return result(exactCandidate.order_id, false);
	// Retained collision locks protect exact late payments, not non-exact payments
	// made in a different checkout window. Never use the scanning order as a tie-break.
	const onTime = eligible.filter(
		(candidate) =>
			transaction.timestamp.getTime() <= candidate.expires_at &&
			BigInt(candidate.received_amount_units) <
				BigInt(candidate.expected_amount_units),
	);
	const [onTimeCandidate] = onTime;
	if (onTimeCandidate && onTime.length === 1)
		return result(onTimeCandidate.order_id, false);
	if (onTime.length > 1 || eligible.length > 1)
		throw new PaymentAttributionAmbiguousError();
	// A sole late candidate is safe to pass to the existing late-payment policy.
	const [onlyCandidate] = eligible;
	if (onlyCandidate && eligible.length === 1)
		return result(onlyCandidate.order_id, false);
	throw new PaymentAttributionNotFoundError();
}

export function paymentTargetAddressMatches(left: string, right: string) {
	return isEvmAddress(left) && isEvmAddress(right)
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}
