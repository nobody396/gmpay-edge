import { z } from "zod";
import { orderIdPathSchema } from "#/features/orders/schema";
import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type {
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";

const transactionHashSchema = z
	.string()
	.trim()
	.min(8)
	.max(256)
	.regex(/^[A-Za-z0-9+/=:_-]+$/);

export type CheckoutTransactionSubmission = {
	orderId: string;
	transactionHash: string;
};

export type CheckoutTransactionResult =
	| { status: "accepted"; orderStatus: string; transactionId: string }
	| { status: "not_found" }
	| { status: "mismatch" }
	| { status: "unavailable" };

type AdapterFactory = (
	db: D1Database,
	receivingMethodId: string,
) => Promise<Array<{ adapter: PaymentAdapter<unknown> }>>;

/**
 * Verifies a payer-supplied transaction against the immutable order target before
 * sending it through the same idempotent accounting path used by scheduled scans.
 */
export async function submitCheckoutTransaction(
	env: PaymentRuntime,
	input: CheckoutTransactionSubmission,
	createAdapters: AdapterFactory = createReceivingMethodAdapters,
	allowLate = false,
): Promise<CheckoutTransactionResult> {
	const orderId = orderIdPathSchema.parse(input.orderId);
	const transactionHash = transactionHashSchema.parse(input.transactionHash);
	const order = await env.DB.prepare(
		`SELECT o.status, o.expires_at, ops.target_value AS address,
		 ops.asset_code, ops.receiving_method_id
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? LIMIT 1`,
	)
		.bind(orderId)
		.first<{
			status: string;
			expires_at: number;
			address: string;
			asset_code: string;
			receiving_method_id: string;
		}>();
	if (!order) return { status: "unavailable" };
	if (
		!["pending", "confirming", "partially_paid"].includes(order.status) &&
		!(allowLate && ["expired", "cancelled"].includes(order.status))
	) {
		return { status: "unavailable" };
	}

	const adapters = (
		await createAdapters(env.DB, order.receiving_method_id)
	).map((candidate) => candidate.adapter);
	if (!adapters.length) return { status: "unavailable" };
	let matchedTransaction: NormalizedTransaction | undefined;
	let sawTransaction = false;
	for (const adapter of adapters) {
		try {
			const transaction = await adapter.getTransaction(transactionHash, {
				address: order.address,
				assetCode: order.asset_code,
			});
			if (!transaction) continue;
			sawTransaction = true;
			const target = await adapter.createPaymentTarget({
				address: order.address,
				expiresAt: new Date(order.expires_at),
			});
			if (adapter.validatePayment(transaction, target, order.asset_code)) {
				matchedTransaction = transaction;
				break;
			}
		} catch (error) {
			if (!adapter.isRetryable(adapter.classifyError(error))) throw error;
		}
	}
	if (!matchedTransaction)
		return { status: sawTransaction ? "mismatch" : "not_found" };
	try {
		const attribution = await resolvePaymentTransactionOrder(
			env.DB,
			matchedTransaction,
			orderId,
			allowLate,
		);
		if (attribution.orderId !== orderId) return { status: "mismatch" };
	} catch (error) {
		if (
			error instanceof PaymentAttributionAmbiguousError ||
			error instanceof PaymentAttributionNotFoundError
		)
			return { status: "mismatch" };
		throw error;
	}

	const result = await recordPaymentTransaction(
		env,
		orderId,
		matchedTransaction,
	);
	return {
		status: "accepted",
		orderStatus: result.status,
		transactionId: paymentTransactionId(matchedTransaction),
	};
}
