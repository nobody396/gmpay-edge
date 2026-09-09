import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";
import { immediateReleaseModeSql } from "#/server/operational-settings";

type AttributionCandidate = {
	order_id: string;
	expected_amount_units: string;
	received_amount_units: string;
};

function isEvmAddress(value: string) {
	return /^0x[0-9a-f]{40}$/i.test(value);
}

export type PaymentAttribution = {
	orderId: string;
	alreadyAttributed: boolean;
};

export class PaymentAttributionAmbiguousError extends DomainError {
	constructor() {
		super(
			"payment_attribution_ambiguous",
			409,
			"Transaction cannot be attributed to one payment order",
		);
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
): Promise<PaymentAttribution> {
	const existing = await db
		.prepare(
			"SELECT order_id FROM order_payments WHERE transaction_id = ? LIMIT 1",
		)
		.bind(paymentTransactionId(transaction))
		.first<{ order_id: string }>();
	if (existing) return { orderId: existing.order_id, alreadyAttributed: true };

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
			 ops.expected_amount_units
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

	const exact = candidates.results.filter((candidate) => {
		const remainingUnits =
			BigInt(candidate.expected_amount_units) -
			BigInt(candidate.received_amount_units);
		return remainingUnits > 0n && remainingUnits === transaction.amountUnits;
	});
	if (exact.length > 1) throw new PaymentAttributionAmbiguousError();
	const [exactCandidate] = exact;
	if (exactCandidate)
		return { orderId: exactCandidate.order_id, alreadyAttributed: false };
	const [onlyCandidate] = candidates.results;
	if (onlyCandidate && candidates.results.length === 1)
		return {
			orderId: onlyCandidate.order_id,
			alreadyAttributed: false,
		};
	if (candidates.results.length > 1)
		throw new PaymentAttributionAmbiguousError();
	throw new PaymentAttributionNotFoundError();
}

export function paymentTargetAddressMatches(left: string, right: string) {
	return isEvmAddress(left) && isEvmAddress(right)
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}
