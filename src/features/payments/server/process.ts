import type { OrderStatus } from "#/features/orders/schema";
import { assertTransition } from "#/features/orders/state-machine";
import {
	findSameTransferAttribution,
	paymentTargetAddressMatches,
	transactionHashKey,
} from "#/features/payments/server/attribution";
import {
	autoApprovalPolicy,
	automaticSettlementBlocker,
	underpaymentToleranceFor,
} from "#/features/payments/server/auto-approval";
import {
	displayOrderAmounts,
	type StoredOrderAmounts,
} from "#/features/payments/server/order-amounts";
import {
	alertUnattributedPayment,
	automaticSettlementAlertText,
	deliverOwnerAlert,
	ownerAlertConfigured,
	ownerAlertStatement,
} from "#/features/payments/server/owner-alert";
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
	options: {
		ownerAlert?: boolean;
		/** Approve this pending review in the same transaction as the payment. */
		review?: { id: string; description: string };
	} = {},
): Promise<{ duplicate: boolean; status: OrderStatus }> {
	const storedOrder = await env.DB.prepare(
		`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
		 o.currency, o.currency_decimals, o.received_amount_units, o.expires_at, o.version,
		 o.created_at,
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
				version: number;
				created_at: number;
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
		!paymentTargetAddressMatches(transaction.to, order.address) ||
		transaction.amountUnits <= 0n
	) {
		throw new DomainError(
			"payment_transaction_mismatch",
			422,
			"Transaction does not match the payment target",
		);
	}
	const sameTransfer = await findSameTransferAttribution(env.DB, transaction);
	if (sameTransfer) {
		if (
			sameTransfer.order_id !== orderId ||
			sameTransfer.amount_units !== transaction.amountUnits.toString()
		)
			throw new PaymentAttributionConflictError();
		return { duplicate: true, status: order.status };
	}
	const transactionId = paymentTransactionId(transaction);
	const expectedUnits = BigInt(order.expected_amount_units);
	const remainingUnits = expectedUnits - BigInt(order.received_amount_units);
	// Automatic settlement only matters where the normal rules would stop:
	// a late, inexact or customer-reviewed transfer on a recent CNY order.
	const automatic =
		order.currency === autoApprovalPolicy.currency &&
		order.created_at >= autoApprovalPolicy.ordersCreatedFromMs &&
		(order.status === "expired" ||
			transaction.amountUnits !== remainingUnits ||
			options.review !== undefined) &&
		(await automaticSettlementBlocker(env.DB, {
			orderId,
			transaction,
			...(options.review ? { reviewId: options.review.id } : {}),
			...(options.review ? { requireFinal: true } : {}),
		})) === null;
	if (options.review && !automatic)
		throw new DomainError(
			"automatic_review_not_allowed",
			409,
			"Payment review needs a person",
		);
	if (
		(order.status === "expired" && !automatic) ||
		order.status === "cancelled"
	) {
		const policy = (await loadOperationalSettings(env.DB)).latePaymentPolicy;
		if (policy !== "accept") {
			const late = await recordLatePayment(
				env,
				{ ...order, paymentAmount: order.paymentAmount },
				transaction,
				policy,
			);
			if (
				!late.duplicate &&
				policy === "review" &&
				options.ownerAlert !== false
			)
				await alertUnattributedPayment(
					env,
					transaction,
					"payment_late_review_required",
					orderId,
				);
			return late;
		}
	}

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
	// Confirmations keep growing after finality; once both observations are past
	// the requirement, a higher count is not a new payment state.
	const sameConfirmationState =
		existingPayment?.confirmations === transaction.confirmations ||
		(existingPayment !== null &&
			existingPayment.confirmations >= order.required_confirmations &&
			transaction.confirmations >= order.required_confirmations);
	if (
		existingPayment &&
		sameConfirmationState &&
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
		expectedUnits,
		requiredConfirmations: order.required_confirmations,
		underpaymentToleranceUnits: automatic
			? underpaymentToleranceFor(order.decimals)
			: 0n,
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
	const selected = await matchingWebhookEndpoints(env.DB, orderId);
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
			: // Re-checks the same-transfer guard inside the batch so a concurrent
				// attribution under another identity rolls this whole write back.
				env.DB.prepare(
					`INSERT OR IGNORE INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, confirmed_at, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					 WHERE NOT EXISTS (
					  SELECT 1 FROM blockchain_transactions bt INDEXED BY blockchain_transactions_hash_nocase_idx
					  JOIN order_payments op
					  ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
					  WHERE bt.network = ? AND LOWER(bt.tx_hash) IN (?, ?)
					  AND LOWER(bt.to_address) = LOWER(?) AND op.transaction_id <> ?
					 )`,
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
					transaction.network,
					transactionHashKey(transaction.hash),
					`0x${transactionHashKey(transaction.hash)}`,
					transaction.to,
					transactionId,
				),
		env.DB.prepare(
			`UPDATE orders SET status = ?, received_amount_units = ?,
			 paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, ?) ELSE NULL END,
			 version = version + 1, updated_at = ? WHERE id = ? AND version = ?
			 AND EXISTS (SELECT 1 FROM order_payments WHERE id = ? AND order_id = ?)`,
		).bind(
			aggregate.status,
			aggregate.receivedUnits.toString(),
			aggregate.status === "paid" || aggregate.status === "overpaid" ? 1 : 0,
			now,
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
		...deliveries.map(({ id, endpoint }) =>
			env.DB.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
			).bind(id, eventId, orderId, endpoint.api_key_id, now, now),
		),
	];
	const settled = (status: OrderStatus) =>
		status === "paid" || status === "overpaid";
	const settlesNow = settled(aggregate.status) && !settled(order.status);
	if (options.review && !settlesNow)
		throw new DomainError(
			"automatic_review_not_settled",
			409,
			"Payment review needs a person",
		);
	// The owner message is written in the same transaction as the settlement
	// and delivered afterwards, so a Telegram outage cannot lose it.
	let alertId: string | null = null;
	if (automatic && settlesNow && options.ownerAlert !== false) {
		const text = await automaticSettlementAlertText(env.DB, {
			orderId,
			transaction,
			receivedUnits: aggregate.receivedUnits,
			lateByMs:
				order.status === "expired"
					? transaction.timestamp.getTime() - order.expires_at
					: null,
			...(options.review
				? { reviewDescription: options.review.description }
				: {}),
		});
		if (text && ownerAlertConfigured(env)) {
			alertId = options.review
				? `auto-review:${options.review.id}`
				: `auto-settle:${orderId}`;
			statements.push(ownerAlertStatement(env.DB, alertId, text, now));
		}
	}
	if (options.review)
		statements.push(
			env.DB.prepare(
				`UPDATE payment_reviews SET status = 'approved', reviewer_user_id = NULL,
				 resolution_note = ?, reviewed_at = ?, updated_at = ?
				 WHERE id = ? AND order_id = ? AND status = 'pending'`,
			).bind(
				`系统自动核验通过：链上交易 ${transactionId} 已确认并入账`,
				now,
				now,
				options.review.id,
				orderId,
			),
			// A person decided first: roll the whole settlement back.
			env.DB.prepare(
				`SELECT CASE WHEN changes() = 1 THEN 1
				 ELSE json_extract('payment review changed', '$') END`,
			),
			env.DB.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
				 VALUES (?, 'payment_review.auto_approved', 'payment_review', ?, ?, ?)`,
			).bind(
				crypto.randomUUID(),
				options.review.id,
				JSON.stringify({
					orderId,
					transactionId,
					orderStatus: aggregate.status,
				}),
				now,
			),
		);
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
			if (
				attributed ||
				(await findSameTransferAttribution(env.DB, transaction))
			)
				throw new PaymentAttributionConflictError();
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

	await dispatchPaymentNotifications(
		env,
		eventId,
		payload,
		deliveries,
		eventType,
	);
	if (alertId) await deliverOwnerAlert(env, alertId);
	return { duplicate: false, status: aggregate.status };
}
