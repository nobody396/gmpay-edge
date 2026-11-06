import { submitCheckoutTransaction } from "#/features/checkout/server/submit-transaction";
import {
	type AutoApprovalOrder,
	autoApprovalApplies,
} from "#/features/payments/server/auto-approval";
import { alertAutoApprovedPayment } from "#/features/payments/server/owner-alert";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";
import { parsePaymentTransactionId } from "#/features/payments/server/reconciliation";

/**
 * Approves a just-submitted payment review without a person when its
 * transaction hash verifies on chain against this order and settles it under
 * the automatic rules. Anything short of a settled order leaves the review
 * pending for the owner; this never rejects a review.
 */
export async function autoApprovePaymentReview(
	env: PaymentRuntime,
	reviewId: string,
	adapterFactory?: Parameters<typeof submitCheckoutTransaction>[2],
): Promise<{ approved: boolean }> {
	const review = await env.DB.prepare(
		`SELECT r.order_id, r.status, r.transaction_hash, r.description,
		 o.created_at, o.expires_at, o.amount_minor, o.currency,
		 ops.asset_code, ops.decimals, ops.rail_code
		 FROM payment_reviews r
		 JOIN orders o ON o.id = r.order_id
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE r.id = ? LIMIT 1`,
	)
		.bind(reviewId)
		.first<
			AutoApprovalOrder & {
				order_id: string;
				status: string;
				transaction_hash: string | null;
				description: string;
				rail_code: string;
			}
		>();
	if (
		!review ||
		review.status !== "pending" ||
		!review.transaction_hash ||
		!autoApprovalApplies(review)
	)
		return { approved: false };

	const verified = await submitCheckoutTransaction(
		env,
		{ orderId: review.order_id, transactionHash: review.transaction_hash },
		adapterFactory,
		false,
		{ reviewOrderId: review.order_id, requireFinal: true, ownerAlert: false },
	).catch(() => null);
	if (
		verified?.status !== "accepted" ||
		(verified.orderStatus !== "paid" && verified.orderStatus !== "overpaid")
	)
		return { approved: false };

	const now = Date.now();
	const note = `系统自动核验通过：链上交易 ${verified.transactionId} 已确认并入账`;
	const [update] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE payment_reviews SET status = 'approved', reviewer_user_id = NULL,
			 resolution_note = ?, reviewed_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
		).bind(note, now, now, reviewId),
		env.DB.prepare(
			`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
			 SELECT ?, 'payment_review.auto_approved', 'payment_review', ?, ?, ?
			 WHERE EXISTS (SELECT 1 FROM payment_reviews
			  WHERE id = ? AND status = 'approved' AND reviewed_at = ?)`,
		).bind(
			crypto.randomUUID(),
			reviewId,
			JSON.stringify({
				orderId: review.order_id,
				orderStatus: verified.orderStatus,
				transactionId: verified.transactionId,
			}),
			now,
			reviewId,
			now,
		),
	]);
	// The order is paid either way; a concurrent owner decision keeps its own record.
	if ((update?.meta.changes ?? 0) !== 1) return { approved: false };

	const received = await env.DB.prepare(
		"SELECT received_amount_units FROM orders WHERE id = ? LIMIT 1",
	)
		.bind(review.order_id)
		.first<{ received_amount_units: string }>();
	await alertAutoApprovedPayment(env, {
		orderId: review.order_id,
		transaction: {
			network: review.rail_code,
			hash: parsePaymentTransactionId(verified.transactionId).hash,
		},
		receivedUnits: BigInt(received?.received_amount_units ?? "0"),
		lateByMs: null,
		reviewDescription: review.description,
	});
	return { approved: true };
}
