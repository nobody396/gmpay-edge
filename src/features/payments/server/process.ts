import type { OrderStatus } from "#/features/orders/schema";
import { assertTransition } from "#/features/orders/state-machine";
import { paymentTargetAddressMatches } from "#/features/payments/server/attribution";
import {
	displayOrderAmounts,
	type StoredOrderAmounts,
} from "#/features/payments/server/order-amounts";
import {
	dispatchPaymentNotifications,
	matchingWebhookEndpoints,
	type PaymentRuntime,
	paymentWebhookInstance,
} from "#/features/payments/server/payment-events";
import {
	type PaymentAggregate,
	PaymentAttributionConflictError,
	paymentTransactionId,
	reconcileOrderPayment,
} from "#/features/payments/server/reconciliation";
import { recordLatePayment } from "#/features/payments/server/record-late-payment";
import type { OrderWebhookPayload } from "#/features/webhooks/types";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";
import { loadOperationalSettings } from "#/server/operational-settings";
import type { RuntimeConfig } from "#/server/runtime-config";

export async function recordPaymentTransaction(
	env: PaymentRuntime,
	orderId: string,
	transaction: NormalizedTransaction,
	runtime?: RuntimeConfig,
): Promise<{ duplicate: boolean; status: OrderStatus }> {
	const storedOrder = await env.DB.prepare(
		`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
		 o.currency, o.currency_decimals, o.received_amount_units, o.expires_at, o.paid_at, o.version,
		 ops.expected_amount_units, ops.asset_code AS code, ops.rail_code AS network, ops.decimals,
		 ops.target_value AS address, ops.required_confirmations
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? LIMIT 1`,
	)
		.bind(orderId)
		.first<
			StoredOrderAmounts & {
				id: string;
				external_order_id: string;
				status: OrderStatus;
				currency: string;
				received_amount_units: string;
				expires_at: number;
				paid_at: number | null;
				version: number;
				code: string;
				network: string;
				decimals: number;
				address: string;
				required_confirmations: number;
			}
		>();
	if (!storedOrder) {
		throw new DomainError(
			"payment_order_not_found",
			404,
			"Payment order not found",
		);
	}
	const order = displayOrderAmounts(storedOrder);
	if (order.paymentAmount === null || order.expected_amount_units === null) {
		throw new Error("Order payment snapshot is incomplete");
	}
	if (
		transaction.network !== order.network ||
		transaction.assetCode !== order.code ||
		!paymentTargetAddressMatches(
			transaction.network,
			transaction.to,
			order.address,
		) ||
		transaction.amountUnits <= 0n
	) {
		throw new DomainError(
			"payment_transaction_mismatch",
			422,
			"Transaction does not match the payment target",
		);
	}
	if (order.status === "expired" || order.status === "cancelled") {
		const policy = (await loadOperationalSettings(env.DB)).latePaymentPolicy;
		if (policy !== "accept") {
			return recordLatePayment(
				env,
				{ ...order, paymentAmount: order.paymentAmount },
				transaction,
				policy,
			);
		}
	}

	const transactionId = paymentTransactionId(transaction);
	const existingPayment = await env.DB.prepare(
		`SELECT op.id, op.order_id, op.amount_units, op.confirmations, op.status,
		 bt.block_hash, bt.status AS blockchain_status
		 FROM order_payments op LEFT JOIN blockchain_transactions bt
		 ON bt.network = ? AND bt.tx_hash = ? AND bt.event_index = ?
		 WHERE op.transaction_id = ? LIMIT 1`,
	)
		.bind(
			transaction.network,
			transaction.hash,
			transaction.eventIndex,
			transactionId,
		)
		.first<{
			id: string;
			order_id: string;
			amount_units: string;
			confirmations: number;
			status: PaymentAggregate["status"];
			block_hash: string | null;
			blockchain_status: string | null;
		}>();
	if (existingPayment && existingPayment.order_id !== orderId) {
		throw new PaymentAttributionConflictError();
	}
	if (
		existingPayment &&
		existingPayment.amount_units !== transaction.amountUnits.toString()
	) {
		throw new DomainError(
			"payment_transaction_changed",
			409,
			"A previously observed transaction changed amount",
		);
	}
	const paymentStatus: PaymentAggregate["status"] =
		transaction.canonical === false
			? "reorged"
			: !transaction.success
				? "rejected"
				: transaction.confirmations >= order.required_confirmations
					? "confirmed"
					: transaction.confirmations > 0
						? "confirming"
						: "detected";
	const blockchainStatus =
		paymentStatus === "reorged"
			? "reorged"
			: paymentStatus === "rejected"
				? "failed"
				: paymentStatus === "confirmed"
					? "confirmed"
					: "pending";
	if (
		existingPayment &&
		existingPayment.confirmations === transaction.confirmations &&
		existingPayment.status === paymentStatus &&
		existingPayment.block_hash === transaction.blockHash &&
		existingPayment.blockchain_status === blockchainStatus
	) {
		return { duplicate: true, status: order.status };
	}

	const prior = await env.DB.prepare(
		"SELECT amount_units, confirmations, status FROM order_payments WHERE order_id = ? AND transaction_id <> ?",
	)
		.bind(orderId, transactionId)
		.all<{
			amount_units: string;
			confirmations: number;
			status: PaymentAggregate["status"];
		}>();
	const aggregate = reconcileOrderPayment({
		expectedUnits: BigInt(order.expected_amount_units),
		requiredConfirmations: order.required_confirmations,
		payments: [
			...prior.results.map((payment) => ({
				amountUnits: BigInt(payment.amount_units),
				confirmations: payment.confirmations,
				status: payment.status,
			})),
			{
				amountUnits: transaction.amountUnits,
				confirmations: transaction.confirmations,
				status: paymentStatus,
			},
		],
	});
	assertTransition(
		order.status,
		aggregate.status,
		transaction.canonical === false
			? "chain_reorg"
			: existingPayment
				? "confirmations_updated"
				: "payment_detected",
	);

	const now = Date.now();
	const statusChanged = order.status !== aggregate.status;
	const eventId = crypto.randomUUID();
	const eventType = `order.${aggregate.status}` as OrderWebhookPayload["event"];
	const payload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance: await paymentWebhookInstance(env.DB, runtime),
		orderId,
		externalOrderId: order.external_order_id,
		status: aggregate.status,
		amount: order.amount,
		currency: order.currency,
		payment: {
			amount: order.paymentAmount,
			asset: order.code,
			network: order.network,
			receivedAmountUnits: aggregate.receivedUnits.toString(),
		},
		transaction: {
			hash: transaction.hash,
			eventIndex: transaction.eventIndex,
			amountUnits: transaction.amountUnits.toString(),
			confirmations: transaction.confirmations,
			blockNumber: transaction.blockNumber.toString(),
		},
	};
	const selected = statusChanged
		? await matchingWebhookEndpoints(env.DB, orderId)
		: [];
	const deliveries = selected.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));

	const paymentRowId = existingPayment?.id ?? crypto.randomUUID();
	const statements = [
		env.DB.prepare(
			`INSERT INTO blockchain_transactions (id, network, tx_hash, event_index, from_address, to_address, asset_code, amount_units, block_number, block_hash, confirmations, status, observed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(network, tx_hash, event_index) DO UPDATE SET
			 block_number = excluded.block_number, block_hash = excluded.block_hash,
			 confirmations = excluded.confirmations, status = excluded.status,
			 updated_at = excluded.updated_at`,
		).bind(
			crypto.randomUUID(),
			transaction.network,
			transaction.hash,
			transaction.eventIndex,
			transaction.from,
			transaction.to,
			transaction.assetCode,
			transaction.amountUnits.toString(),
			transaction.blockNumber.toString(),
			transaction.blockHash,
			transaction.confirmations,
			blockchainStatus,
			transaction.timestamp.getTime(),
			now,
			now,
		),
		existingPayment
			? env.DB.prepare(
					"UPDATE order_payments SET confirmations = ?, status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?",
				).bind(
					transaction.confirmations,
					paymentStatus,
					paymentStatus === "confirmed" ? now : null,
					now,
					existingPayment.id,
				)
			: env.DB.prepare(
					"INSERT OR IGNORE INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).bind(
					paymentRowId,
					orderId,
					transactionId,
					transaction.amountUnits.toString(),
					transaction.confirmations,
					paymentStatus,
					transaction.timestamp.getTime(),
					paymentStatus === "confirmed" ? now : null,
					now,
					now,
				),
		env.DB.prepare(
			`UPDATE orders SET status = ?, received_amount_units = ?, paid_at = ?,
			 version = version + 1, updated_at = ? WHERE id = ? AND version = ?
			 AND EXISTS (SELECT 1 FROM order_payments WHERE id = ? AND order_id = ?)`,
		).bind(
			aggregate.status,
			aggregate.receivedUnits.toString(),
			aggregate.status === "paid" || aggregate.status === "overpaid"
				? order.status === "paid" || order.status === "overpaid"
					? (order.paid_at ?? now)
					: now
				: null,
			now,
			orderId,
			order.version,
			paymentRowId,
			orderId,
		),
		env.DB.prepare(
			`SELECT CASE WHEN changes() = 1 THEN 1
			 ELSE json_extract('payment update conflict', '$') END`,
		),
		...(["paid", "overpaid"].includes(aggregate.status)
			? [
					env.DB.prepare(
						`UPDATE receiving_method_locks SET released_at = ?
						 WHERE order_id = ? AND released_at IS NULL
						 AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND version = ?
						  AND status IN ('paid','overpaid'))`,
					).bind(now, orderId, orderId, order.version + 1),
				]
			: []),
		...(statusChanged
			? [
					env.DB.prepare(
						"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					).bind(
						eventId,
						orderId,
						eventType,
						`${orderId}:${transactionId}:${aggregate.status}:${transaction.confirmations}:${transaction.blockHash}`,
						JSON.stringify(payload),
						now,
						now,
					),
				]
			: []),
		...deliveries.map(({ id, endpoint }) =>
			env.DB.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
			).bind(id, eventId, orderId, endpoint.api_key_id, now, now),
		),
	];
	try {
		await env.DB.batch(statements);
	} catch (error) {
		const attributed = await env.DB.prepare(
			`SELECT op.order_id, op.amount_units, op.confirmations, op.status,
			 bt.block_hash, bt.status AS blockchain_status, o.status AS order_status
			 FROM order_payments op JOIN orders o ON o.id = op.order_id
			 LEFT JOIN blockchain_transactions bt
			 ON bt.network = ? AND bt.tx_hash = ? AND bt.event_index = ?
			 WHERE op.transaction_id = ? LIMIT 1`,
		)
			.bind(
				transaction.network,
				transaction.hash,
				transaction.eventIndex,
				transactionId,
			)
			.first<{
				order_id: string;
				amount_units: string;
				confirmations: number;
				status: PaymentAggregate["status"];
				block_hash: string | null;
				blockchain_status: string | null;
				order_status: OrderStatus;
			}>();
		if (attributed?.order_id !== orderId) {
			if (attributed) throw new PaymentAttributionConflictError();
			throw error;
		}
		if (
			attributed.amount_units !== transaction.amountUnits.toString() ||
			attributed.confirmations !== transaction.confirmations ||
			attributed.status !== paymentStatus ||
			attributed.block_hash !== transaction.blockHash ||
			attributed.blockchain_status !== blockchainStatus
		) {
			throw error;
		}
		return { duplicate: true, status: attributed.order_status };
	}

	if (statusChanged)
		await dispatchPaymentNotifications(
			env,
			eventId,
			payload,
			deliveries,
			eventType,
		);
	return { duplicate: false, status: aggregate.status };
}
