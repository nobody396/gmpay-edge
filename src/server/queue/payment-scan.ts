import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import type { PaymentScanMessage } from "#/features/payments/types";
import type {
	Network,
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import {
	isObservedProviderAdapter,
	providerOperationDurationMs,
	recordProviderOperation,
} from "#/integrations/provider-observability";
import type { RuntimeConfig } from "#/server/runtime-config";

export async function handlePaymentScan(
	message: Message<PaymentScanMessage>,
	env: Env,
	runtime?: RuntimeConfig,
	adapterCache?: Map<string, ReceivingAdaptersPromise>,
): Promise<void> {
	const payment = await env.DB.prepare(
		`SELECT ops.asset_code, ops.target_value, o.provider_order_id,
		 o.payment_scan_cursor
		 FROM order_payment_snapshots ops
		 JOIN orders o ON o.id = ops.order_id
		 WHERE ops.order_id = ? AND ops.receiving_method_id = ? LIMIT 1`,
	)
		.bind(message.body.orderId, message.body.receivingMethodId)
		.first<{
			asset_code: string;
			target_value: string;
			provider_order_id: string | null;
			payment_scan_cursor: string | null;
		}>();
	if (!payment) {
		message.ack();
		return;
	}
	const scan: AuthoritativePaymentScan = {
		...message.body,
		address: payment.target_value,
		...(payment.provider_order_id
			? { providerOrderId: payment.provider_order_id }
			: {}),
		...(payment.payment_scan_cursor
			? { sinceBlock: payment.payment_scan_cursor }
			: {}),
	};
	let candidates: Awaited<ReturnType<typeof createReceivingMethodAdapters>>;
	try {
		const load = () =>
			createReceivingMethodAdapters(
				env.DB,
				message.body.receivingMethodId,
				runtime,
			);
		if (!adapterCache) candidates = await load();
		else {
			const key = message.body.receivingMethodId;
			let pending = adapterCache.get(key);
			if (!pending) {
				pending = load();
				adapterCache.set(key, pending);
			}
			candidates = await pending;
		}
	} catch {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	if (!candidates.length) {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	let failoverCount = 0;
	let emptyScanCursor: bigint | undefined;
	for (const [index, candidate] of candidates.entries()) {
		const startedAt = performance.now();
		let transactions: NormalizedTransaction[];
		let scanCursor: bigint | undefined;
		try {
			transactions = await scanTransactions(
				env.DB,
				scan,
				payment.asset_code,
				candidate.adapter,
				candidate.subscription,
				(cursor) => {
					scanCursor = cursor;
				},
			);
			if (isObservedProviderAdapter(candidate.adapter.id))
				recordProviderOperation({
					adapter: candidate.adapter.id,
					operation: "payment_scan",
					outcome: "success",
					status: transactions.length ? "ok" : "empty",
					errorCode: null,
					durationMs: providerOperationDurationMs(startedAt),
					failoverCount,
				});
		} catch (error) {
			const kind = candidate.adapter.classifyError(error);
			const retryable = candidate.adapter.isRetryable(kind);
			const willFailover = retryable && index < candidates.length - 1;
			if (willFailover) failoverCount += 1;
			if (isObservedProviderAdapter(candidate.adapter.id))
				recordProviderOperation({
					adapter: candidate.adapter.id,
					operation: "payment_scan",
					outcome: "failure",
					status: "error",
					errorCode: kind,
					durationMs: providerOperationDurationMs(startedAt),
					failoverCount,
				});
			if (candidate.connectionId)
				await updateConnectionHealth(
					env.DB,
					candidate.connectionId,
					"unhealthy",
					kind,
				);
			if (!retryable) {
				await recordPaymentScanIssue(env.DB, message.body, kind);
				message.ack();
				return;
			}
			continue;
		}
		if (candidate.connectionId)
			await updateConnectionHealth(
				env.DB,
				candidate.connectionId,
				"healthy",
				null,
			);
		if (!transactions.length) {
			if (scanCursor == null) {
				message.ack();
				return;
			}
			emptyScanCursor =
				emptyScanCursor == null || scanCursor < emptyScanCursor
					? scanCursor
					: emptyScanCursor;
			if (index < candidates.length - 1) {
				failoverCount += 1;
			}
			continue;
		}
		await processScannedTransactions(
			env,
			message.body.orderId,
			transactions,
			runtime,
		);
		let persistedCursor = scanCursor;
		if (
			emptyScanCursor != null &&
			(persistedCursor == null || emptyScanCursor < persistedCursor)
		)
			persistedCursor = emptyScanCursor;
		await advancePaymentScanCursor(
			env.DB,
			message.body.orderId,
			transactions,
			persistedCursor,
		);
		message.ack();
		return;
	}
	if (emptyScanCursor != null) {
		await advancePaymentScanCursor(
			env.DB,
			message.body.orderId,
			[],
			emptyScanCursor,
		);
		message.ack();
		return;
	}
	await recordPaymentScanIssue(env.DB, message.body, "connections_unavailable");
	message.retry();
}

type ReceivingAdaptersPromise = ReturnType<
	typeof createReceivingMethodAdapters
>;

export async function scanTransactions(
	db: D1Database,
	message: AuthoritativePaymentScan,
	assetCode: string,
	adapter: PaymentAdapter<unknown>,
	subscription?: {
		connectionId: string;
		adapter: PaymentAdapter<unknown>;
	},
	onCursor?: (cursor: bigint) => void,
) {
	const pushed: NormalizedTransaction[] = [];
	const subscriptionAdapter = subscription?.adapter ?? adapter;
	const subscriptionController = new AbortController();
	let subscriptionTask: Promise<void> | undefined;
	if (subscriptionAdapter.subscribeTransactions) {
		// WSS connections are opt-in and consumed for a bounded queue-task
		// window. They run alongside the authoritative HTTP poll rather than
		// adding a fixed delay after it. A dropped socket cannot lose a payment.
		const subscriptionWindowMs = 5_000;
		subscriptionTask = subscriptionAdapter
			.subscribeTransactions({
				address: message.address,
				assetCode,
				signal: AbortSignal.any([
					subscriptionController.signal,
					AbortSignal.timeout(subscriptionWindowMs),
				]),
				onTransaction: (transaction) => {
					pushed.push(transaction);
				},
			})
			.then(() => undefined)
			.catch(async (error: unknown) => {
				if (subscription)
					await updateConnectionHealth(
						db,
						subscription.connectionId,
						"unhealthy",
						subscriptionAdapter.classifyError(error),
					);
				// Subscription transport is an optimization. The HTTP poll below
				// remains the recovery path when a provider rejects or drops WSS.
			});
	}
	try {
		const scanResult = message.providerOrderId
			? [
					await adapter.getTransaction(message.providerOrderId, {
						address: message.address,
						assetCode,
					}),
				].filter(
					(transaction): transaction is NonNullable<typeof transaction> =>
						transaction !== null,
				)
			: adapter.findTransactionsWithCursor
				? await adapter.findTransactionsWithCursor({
						address: message.address,
						assetCode,
						...(message.sinceBlock
							? { sinceBlock: BigInt(message.sinceBlock) }
							: {}),
					})
				: await adapter.findTransactions({
						address: message.address,
						assetCode,
						...(message.sinceBlock
							? { sinceBlock: BigInt(message.sinceBlock) }
							: {}),
					});
		const discovered = Array.isArray(scanResult)
			? scanResult
			: scanResult.transactions;
		if (!Array.isArray(scanResult)) onCursor?.(scanResult.cursor);
		const pending = await refreshPendingPaymentTransactions(
			db,
			message.orderId,
			adapter,
		);
		return mergeScannedTransactions(discovered, pushed, pending);
	} finally {
		subscriptionController.abort();
		await subscriptionTask;
	}
}

type AuthoritativePaymentScan = PaymentScanMessage & {
	address: string;
	providerOrderId?: string;
	sinceBlock?: string;
};

export async function refreshPendingPaymentTransactions(
	db: D1Database,
	orderId: string,
	adapter: PaymentAdapter<unknown>,
) {
	const rows = await db
		.prepare(
			`SELECT bt.network, bt.tx_hash, bt.event_index, bt.from_address,
			 bt.to_address, bt.asset_code, bt.amount_units, bt.block_number,
			 bt.block_hash, bt.confirmations, bt.status, bt.observed_at
			 FROM order_payments op JOIN blockchain_transactions bt
			 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
			 WHERE op.order_id = ? AND op.status IN ('detected', 'confirming', 'confirmed')`,
		)
		.bind(orderId)
		.all<{
			network: Network;
			tx_hash: string;
			event_index: number;
			from_address: string;
			to_address: string;
			asset_code: string;
			amount_units: string;
			block_number: string;
			block_hash: string;
			confirmations: number;
			status: string;
			observed_at: number;
		}>();
	const refreshed: NormalizedTransaction[] = [];
	for (const row of rows.results) {
		const stored: NormalizedTransaction = {
			network: row.network,
			hash: row.tx_hash,
			eventIndex: row.event_index,
			from: row.from_address,
			to: row.to_address,
			assetCode: row.asset_code,
			amountUnits: BigInt(row.amount_units),
			blockNumber: BigInt(row.block_number),
			blockHash: row.block_hash,
			confirmations: row.confirmations,
			timestamp: new Date(row.observed_at),
			success: true,
			canonical: true,
		};
		const current = await findCurrentTransactionEvent(adapter, stored);
		if (current) {
			if (row.status === "missing")
				await db
					.prepare(
						"UPDATE blockchain_transactions SET status = 'pending', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ? AND status = 'missing'",
					)
					.bind(Date.now(), row.network, row.tx_hash, row.event_index)
					.run();
			refreshed.push(current);
		} else if (row.status === "missing")
			refreshed.push({
				...stored,
				confirmations: 0,
				canonical: false,
			});
		else
			await db
				.prepare(
					"UPDATE blockchain_transactions SET status = 'missing', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ?",
				)
				.bind(Date.now(), row.network, row.tx_hash, row.event_index)
				.run();
	}
	return refreshed;
}

async function findCurrentTransactionEvent(
	adapter: PaymentAdapter<unknown>,
	stored: NormalizedTransaction,
) {
	const direct = await adapter.getTransaction(stored.hash, {
		address: stored.to,
		assetCode: stored.assetCode,
		eventIndex: stored.eventIndex,
	});
	return sameTransactionEvent(direct, stored) ? direct : undefined;
}

function sameTransactionEvent(
	candidate: NormalizedTransaction | null | undefined,
	stored: NormalizedTransaction,
) {
	return (
		candidate?.network === stored.network &&
		candidate.hash === stored.hash &&
		candidate.eventIndex === stored.eventIndex
	);
}

function mergeScannedTransactions(...groups: NormalizedTransaction[][]) {
	const merged = new Map<string, NormalizedTransaction>();
	for (const transaction of groups.flat())
		merged.set(
			`${transaction.network}:${transaction.hash}:${transaction.eventIndex}`,
			transaction,
		);
	return [...merged.values()];
}

export async function advancePaymentScanCursor(
	db: D1Database,
	orderId: string,
	transactions: Array<{ blockNumber: bigint }>,
	scanCursor?: bigint,
) {
	if (!transactions.length && scanCursor == null) return null;
	const cursor =
		scanCursor ??
		transactions.reduce(
			(maximum, transaction) =>
				transaction.blockNumber > maximum ? transaction.blockNumber : maximum,
			0n,
		);
	await db
		.prepare(
			`UPDATE orders SET payment_scan_cursor = CASE
			 WHEN payment_scan_cursor IS NULL OR CAST(payment_scan_cursor AS INTEGER) < CAST(? AS INTEGER)
			 THEN ? ELSE payment_scan_cursor END
			 WHERE id = ?`,
		)
		.bind(cursor.toString(), cursor.toString(), orderId)
		.run();
	return cursor;
}

export async function processScannedTransactions(
	env: Env,
	orderId: string,
	transactions: Parameters<typeof recordPaymentTransaction>[2][],
	runtime?: RuntimeConfig,
) {
	let skippedPreviouslyAttributed = 0;
	let skippedAmbiguous = 0;
	for (const transaction of transactions) {
		try {
			const attribution = await resolvePaymentTransactionOrder(
				env.DB,
				transaction,
				orderId,
			);
			await recordPaymentTransaction(
				env,
				attribution.orderId,
				transaction,
				runtime,
			);
			if (attribution.orderId !== orderId) skippedPreviouslyAttributed += 1;
		} catch (error) {
			if (
				!(error instanceof PaymentAttributionAmbiguousError) &&
				!(error instanceof PaymentAttributionNotFoundError)
			)
				throw error;
			skippedAmbiguous += 1;
		}
	}
	return { skippedPreviouslyAttributed, skippedAmbiguous };
}

async function recordPaymentScanIssue(
	db: D1Database,
	message: PaymentScanMessage,
	kind: string,
) {
	await db
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'payment.scan_failed', 'order', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			message.orderId,
			JSON.stringify({
				receivingMethodId: message.receivingMethodId,
				kind,
			}),
			Date.now(),
		)
		.run();
}

export async function updateConnectionHealth(
	db: D1Database,
	connectionId: string,
	status: "healthy" | "unhealthy",
	errorCode: string | null,
) {
	await db
		.prepare(
			`UPDATE payment_ingresses SET health_status = ?, last_checked_at = ?,
				 last_error_code = ?, updated_at = ? WHERE id = ?
				 AND EXISTS (
				  SELECT 1 FROM payment_rails rail
				  WHERE rail.code = payment_ingresses.rail_code AND rail.kind = 'chain'
				 )`,
		)
		.bind(status, Date.now(), errorCode, Date.now(), connectionId)
		.run();
}
