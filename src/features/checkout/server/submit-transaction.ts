import { z } from "zod";
import { orderIdPathSchema } from "#/features/orders/schema";
import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import {
	type AutoApprovalOrder,
	autoApprovalApplies,
	withinAutoApprovalWindow,
} from "#/features/payments/server/auto-approval";
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

type SubmissionOrder = AutoApprovalOrder & {
	status: string;
	address: string;
	receiving_method_id: string;
	required_confirmations: number;
};

/**
 * Verifies a payer-supplied transaction against the immutable order target before
 * sending it through the same idempotent accounting path used by scheduled scans.
 * Customers may also complete an expired order that qualifies for automatic
 * approval, as long as the transfer itself falls inside the late grace window.
 */
export async function submitCheckoutTransaction(
	env: PaymentRuntime,
	input: CheckoutTransactionSubmission,
	createAdapters: AdapterFactory = createReceivingMethodAdapters,
	allowLate = false,
	options: {
		/** Approve this pending review atomically with the payment. */
		review?: { id: string; description: string };
		/** Refuse a transfer that has not reached the required confirmations. */
		requireFinal?: boolean;
	} = {},
): Promise<CheckoutTransactionResult> {
	const orderId = orderIdPathSchema.parse(input.orderId);
	const transactionHash = transactionHashSchema.parse(input.transactionHash);
	const order = await env.DB.prepare(
		`SELECT o.status, o.expires_at, o.created_at, o.amount_minor, o.currency,
		 ops.target_value AS address, ops.asset_code, ops.decimals,
		 ops.receiving_method_id, ops.required_confirmations,
		 ops.expected_amount_units, ops.rail_kind, ops.rail_code, ops.contract_address
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? LIMIT 1`,
	)
		.bind(orderId)
		.first<SubmissionOrder>();
	if (!order) return { status: "unavailable" };
	const automaticLate =
		!allowLate && order.status === "expired" && autoApprovalApplies(order);
	if (
		!["pending", "confirming", "partially_paid"].includes(order.status) &&
		!(allowLate && ["expired", "cancelled"].includes(order.status)) &&
		!automaticLate
	) {
		return { status: "unavailable" };
	}

	const verified = await fetchOrderTransaction(
		env.DB,
		order,
		transactionHash,
		createAdapters,
	);
	if (verified.status !== "matched") return verified;
	const matchedTransaction = verified.transaction;
	if (
		automaticLate &&
		!withinAutoApprovalWindow(order, matchedTransaction.timestamp.getTime())
	)
		return { status: "mismatch" };
	if (
		options.requireFinal &&
		(!matchedTransaction.success ||
			matchedTransaction.canonical === false ||
			matchedTransaction.confirmations < order.required_confirmations)
	)
		return { status: "unavailable" };
	try {
		const attribution = await resolvePaymentTransactionOrder(
			env.DB,
			matchedTransaction,
			orderId,
			allowLate,
			options.review?.id,
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
		undefined,
		options.review ? { review: options.review } : {},
	);
	return {
		status: "accepted",
		orderStatus: result.status,
		transactionId: paymentTransactionId(matchedTransaction),
	};
}

/** Looks the hash up on chain ourselves; the payer's hash is only a lookup hint. */
async function fetchOrderTransaction(
	db: D1Database,
	order: SubmissionOrder,
	transactionHash: string,
	createAdapters: AdapterFactory,
): Promise<
	| { status: "matched"; transaction: NormalizedTransaction }
	| { status: "not_found" | "mismatch" | "unavailable" }
> {
	const adapters = (await createAdapters(db, order.receiving_method_id)).map(
		(candidate) => candidate.adapter,
	);
	if (!adapters.length) return { status: "unavailable" };
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
			if (adapter.validatePayment(transaction, target, order.asset_code))
				return { status: "matched", transaction };
		} catch (error) {
			if (!adapter.isRetryable(adapter.classifyError(error))) throw error;
		}
	}
	return { status: sawTransaction ? "mismatch" : "not_found" };
}
