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
 * more than one order can receive the transfer. An inexact amount is only a
 * guess: it may top up an open balance, but settling or overpaying an order with
 * it needs an administrator-approved review.
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
	const sameTransfer = await findSameTransferAttribution(db, transaction);
	if (sameTransfer) {
		if (sameTransfer.amount_units !== transaction.amountUnits.toString())
			throw new PaymentAttributionAmbiguousError(
				"payment_transfer_already_attributed",
			);
		return result(sameTransfer.order_id, true);
	}

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
	const remainingUnits = (candidate: AttributionCandidate) =>
		BigInt(candidate.expected_amount_units) -
		BigInt(candidate.received_amount_units);
	const exact = eligible.filter((candidate) => {
		const remaining = remainingUnits(candidate);
		return remaining > 0n && remaining === transaction.amountUnits;
	});
	if (exact.length > 1) throw new PaymentAttributionAmbiguousError();
	const [exactCandidate] = exact;
	if (exactCandidate) return result(exactCandidate.order_id, false);
	// Retained collision locks protect exact late payments, not non-exact payments
	// made in a different checkout window. Never use the scanning order as a tie-break.
	const inexact = (candidate: AttributionCandidate) => {
		if (!allowReviewed && transaction.amountUnits >= remainingUnits(candidate))
			throw new PaymentAttributionAmbiguousError(
				"payment_amount_review_required",
			);
		return result(candidate.order_id, false);
	};
	const onTime = eligible.filter(
		(candidate) =>
			transaction.timestamp.getTime() <= candidate.expires_at &&
			remainingUnits(candidate) > 0n,
	);
	const [onTimeCandidate] = onTime;
	if (onTimeCandidate && onTime.length === 1) return inexact(onTimeCandidate);
	if (onTime.length > 1 || eligible.length > 1)
		throw new PaymentAttributionAmbiguousError();
	// A sole late candidate is safe to pass to the existing late-payment policy.
	const [onlyCandidate] = eligible;
	if (onlyCandidate && eligible.length === 1) return inexact(onlyCandidate);
	throw new PaymentAttributionNotFoundError();
}

/**
 * One transfer to one receiving address credits at most one order payment.
 * Providers have reported the same transfer under different event indexes, and
 * payers paste hashes in any case or with `0x`, so the stored event identity
 * alone cannot enforce this.
 */
export async function findSameTransferAttribution(
	db: D1Database,
	transaction: NormalizedTransaction,
) {
	const hash = transactionHashKey(transaction.hash);
	const rows = await db
		.prepare(
			`SELECT op.order_id, op.amount_units, bt.to_address
			 FROM blockchain_transactions bt INDEXED BY blockchain_transactions_hash_nocase_idx
			 JOIN order_payments op
			 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
			 WHERE bt.network = ? AND LOWER(bt.tx_hash) IN (?, ?)
			 AND op.transaction_id <> ? LIMIT 20`,
		)
		.bind(
			transaction.network,
			hash,
			`0x${hash}`,
			paymentTransactionId(transaction),
		)
		.all<{ order_id: string; amount_units: string; to_address: string }>();
	return (
		rows.results.find((row) =>
			paymentTargetAddressMatches(row.to_address, transaction.to),
		) ?? null
	);
}

/** Case- and `0x`-insensitive key for comparing a transaction hash across sources. */
export function transactionHashKey(hash: string) {
	return hash.replace(/^0x/i, "").toLowerCase();
}

export function paymentTargetAddressMatches(left: string, right: string) {
	return isEvmAddress(left) && isEvmAddress(right)
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}
