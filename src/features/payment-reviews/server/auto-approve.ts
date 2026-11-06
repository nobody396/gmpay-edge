import { submitCheckoutTransaction } from "#/features/checkout/server/submit-transaction";
import { autoApprovalPolicy } from "#/features/payments/server/auto-approval";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";

/**
 * Approves a just-submitted payment review without a person when its
 * transaction hash verifies on chain against this order and settles it under
 * the automatic rules. Payment, order settlement and the review decision
 * commit in one transaction (see recordPaymentTransaction), so an owner who
 * decides first always wins. Anything short of that leaves the review pending;
 * this never rejects a review.
 */
export async function autoApprovePaymentReview(
	env: PaymentRuntime,
	reviewId: string,
	adapterFactory?: Parameters<typeof submitCheckoutTransaction>[2],
): Promise<{ approved: boolean }> {
	const review = await env.DB.prepare(
		`SELECT r.order_id, r.status, r.transaction_hash, r.description,
		 o.created_at, o.currency
		 FROM payment_reviews r JOIN orders o ON o.id = r.order_id
		 WHERE r.id = ? LIMIT 1`,
	)
		.bind(reviewId)
		.first<{
			order_id: string;
			status: string;
			transaction_hash: string | null;
			description: string;
			created_at: number;
			currency: string;
		}>();
	if (
		!review ||
		review.status !== "pending" ||
		!review.transaction_hash ||
		review.currency !== autoApprovalPolicy.currency ||
		review.created_at < autoApprovalPolicy.ordersCreatedFromMs
	)
		return { approved: false };

	await submitCheckoutTransaction(
		env,
		{ orderId: review.order_id, transactionHash: review.transaction_hash },
		adapterFactory,
		false,
		{
			review: { id: reviewId, description: review.description },
			requireFinal: true,
		},
	).catch(() => null);
	// The stored decision is the only truth: approved means the payment and the
	// settlement committed together with it.
	const decided = await env.DB.prepare(
		"SELECT status FROM payment_reviews WHERE id = ? LIMIT 1",
	)
		.bind(reviewId)
		.first<{ status: string }>();
	return { approved: decided?.status === "approved" };
}
