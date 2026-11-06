import { createTelegramApi } from "#/features/telegram/server/client";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { unitsToDecimal } from "#/lib/money";

declare global {
	interface Env {
		/** Optional owner alert channel; all three are Worker secrets. */
		OWNER_ALERT_TELEGRAM_BOT_TOKEN?: string;
		OWNER_ALERT_TELEGRAM_CHAT_ID?: string;
		OWNER_ALERT_TELEGRAM_THREAD_ID?: string;
	}
}

export type OwnerAlertEnv = Pick<
	Env,
	| "DB"
	| "OWNER_ALERT_TELEGRAM_BOT_TOKEN"
	| "OWNER_ALERT_TELEGRAM_CHAT_ID"
	| "OWNER_ALERT_TELEGRAM_THREAD_ID"
>;

type OrderSummary = {
	id: string;
	description: string | null;
	status: string;
	received_amount_units: string;
	expected_amount_units: string;
	decimals: number;
	asset_code: string;
};

const unattributedReasons: Record<string, string> = {
	payment_amount_review_required:
		"金额和订单应付不一致（多付或少付），不能自动入账",
	payment_attribution_ambiguous: "同时有多笔订单可能对应，无法判断归属",
	payment_review_pending: "该订单客户已提交付款复核",
	payment_transfer_already_attributed: "同一笔转账已记到别的订单",
	payment_attribution_not_found: "没有找到匹配的订单",
	payment_late_review_required:
		"订单过期后才到账，且不满足自动入账条件（过期超过 6 小时、金额不足、超过 ¥3300 或是旧订单）",
};

/**
 * Sends one plain-text message to the owner's Telegram group. Alerts never
 * block or fail payment processing; an unconfigured channel is a no-op.
 */
export async function sendOwnerAlert(
	env: OwnerAlertEnv,
	text: string,
	request: typeof fetch = fetch,
) {
	const token = env.OWNER_ALERT_TELEGRAM_BOT_TOKEN;
	const chatId = env.OWNER_ALERT_TELEGRAM_CHAT_ID;
	if (!token || !chatId) return false;
	const thread = Number(env.OWNER_ALERT_TELEGRAM_THREAD_ID);
	try {
		await createTelegramApi(token, request).sendMessage(
			chatId,
			text,
			Number.isSafeInteger(thread) && thread > 0
				? { message_thread_id: thread }
				: undefined,
		);
		return true;
	} catch {
		console.warn("Owner payment alert could not be sent");
		return false;
	}
}

export async function alertUnattributedPayment(
	env: OwnerAlertEnv,
	transaction: NormalizedTransaction,
	reason: string,
	scannedOrderId: string,
	request?: typeof fetch,
) {
	const order = await loadOrderSummary(
		env.DB,
		scannedOrderId,
		transaction.network,
		transaction.assetCode,
	).catch(() => null);
	const received = order
		? `${unitsToDecimal(transaction.amountUnits, order.decimals)} ${transaction.assetCode}`
		: `${transaction.amountUnits.toString()} 最小单位 ${transaction.assetCode}`;
	return sendOwnerAlert(
		env,
		[
			"⚠️ GMPay 收到一笔转账，但没有自动入账",
			`原因：${unattributedReasons[reason] ?? reason}`,
			`收到：${received}（${transaction.network}）`,
			order ? `可能对应：${describeOrder(order)}` : null,
			`交易：${transaction.hash}`,
			"需要在 GMPay 后台人工核对处理。",
		]
			.filter(Boolean)
			.join("\n"),
		request,
	);
}

export async function alertPaymentReviewSubmitted(
	env: OwnerAlertEnv,
	review: { orderId: string; transactionHash?: string; description: string },
	request?: typeof fetch,
) {
	const order = await loadOrderSummary(env.DB, review.orderId).catch(
		() => null,
	);
	return sendOwnerAlert(
		env,
		[
			"⚠️ 客户提交了付款复核",
			order ? `订单：${describeOrder(order)}` : `订单：GMPay ${review.orderId}`,
			order
				? `已收：${unitsToDecimal(BigInt(order.received_amount_units), order.decimals)} ${order.asset_code}`
				: null,
			`交易：${review.transactionHash ?? "客户未填写"}`,
			`客户说明：${review.description.slice(0, 200)}`,
			"需要在 GMPay 后台「付款复核」处理。",
		]
			.filter(Boolean)
			.join("\n"),
		request,
	);
}

export function ownerAlertConfigured(env: OwnerAlertEnv) {
	return Boolean(
		env.OWNER_ALERT_TELEGRAM_BOT_TOKEN && env.OWNER_ALERT_TELEGRAM_CHAT_ID,
	);
}

/** Queues a message inside the caller's transaction; `id` deduplicates it. */
export function ownerAlertStatement(
	db: D1Database,
	id: string,
	text: string,
	now: number,
) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO owner_alert_outbox
			 (id, text, attempt_count, next_attempt_at, sent_at, created_at, updated_at)
			 VALUES (?, ?, 0, ?, NULL, ?, ?)`,
		)
		.bind(id, text, now, now, now);
}

const maxOwnerAlertAttempts = 12;

/**
 * Delivers one queued message at most once at a time: a short lease claims
 * it, success marks it sent, failure backs off until the scheduled retry.
 */
export async function deliverOwnerAlert(
	env: OwnerAlertEnv,
	id: string,
	request?: typeof fetch,
	now = Date.now(),
) {
	if (!ownerAlertConfigured(env)) return false;
	const claimed = await env.DB.prepare(
		`UPDATE owner_alert_outbox SET attempt_count = attempt_count + 1,
		 next_attempt_at = ?, updated_at = ?
		 WHERE id = ? AND sent_at IS NULL AND next_attempt_at <= ? AND attempt_count < ?
		 RETURNING text, attempt_count`,
	)
		.bind(now + 120_000, now, id, now, maxOwnerAlertAttempts)
		.first<{ text: string; attempt_count: number }>()
		.catch(() => null);
	if (!claimed) return false;
	const sent = await sendOwnerAlert(env, claimed.text, request);
	await env.DB.prepare(
		sent
			? "UPDATE owner_alert_outbox SET sent_at = ?, updated_at = ? WHERE id = ?"
			: "UPDATE owner_alert_outbox SET next_attempt_at = ?, updated_at = ? WHERE id = ?",
	)
		.bind(
			sent ? now : now + Math.min(60, 2 ** claimed.attempt_count) * 60_000,
			now,
			id,
		)
		.run()
		.catch(() => undefined);
	return sent;
}

export async function hasDueOwnerAlerts(env: OwnerAlertEnv, now: number) {
	if (!ownerAlertConfigured(env)) return false;
	const row = await env.DB.prepare(
		`SELECT 1 AS due FROM owner_alert_outbox INDEXED BY owner_alert_outbox_due_idx
		 WHERE sent_at IS NULL AND next_attempt_at <= ? AND attempt_count < ? LIMIT 1`,
	)
		.bind(now, maxOwnerAlertAttempts)
		.first();
	return row !== null;
}

/** Scheduled retry of messages whose immediate delivery failed. */
export async function retryOwnerAlerts(env: OwnerAlertEnv, now = Date.now()) {
	if (!ownerAlertConfigured(env)) return { due: 0, sent: 0 };
	const due = await env.DB.prepare(
		`SELECT id FROM owner_alert_outbox INDEXED BY owner_alert_outbox_due_idx
		 WHERE sent_at IS NULL AND next_attempt_at <= ? AND attempt_count < ?
		 ORDER BY next_attempt_at LIMIT 20`,
	)
		.bind(now, maxOwnerAlertAttempts)
		.all<{ id: string }>();
	let sent = 0;
	for (const row of due.results)
		if (await deliverOwnerAlert(env, row.id, undefined, now)) sent += 1;
	return { due: due.results.length, sent };
}

/** One message per automatic settlement, so the owner can spot-check it. */
export async function automaticSettlementAlertText(
	db: D1Database,
	settlement: {
		orderId: string;
		transaction: Pick<NormalizedTransaction, "network" | "hash">;
		receivedUnits: bigint;
		/** Transfer time minus expiry; null when the order was still open. */
		lateByMs: number | null;
		/** Set when a customer's payment review was approved automatically. */
		reviewDescription?: string;
	},
) {
	const order = await loadOrderSummary(db, settlement.orderId).catch(
		() => null,
	);
	if (!order) return null;
	const expected = BigInt(order.expected_amount_units);
	const difference = settlement.receivedUnits - expected;
	const amountNote =
		difference === 0n
			? "金额一致"
			: difference > 0n
				? `多付 ${unitsToDecimal(difference, order.decimals)} ${order.asset_code}`
				: `少付 ${unitsToDecimal(-difference, order.decimals)} ${order.asset_code}（在 0.1 以内）`;
	const lateNote =
		settlement.lateByMs === null
			? null
			: settlement.lateByMs > 0
				? `订单过期后 ${Math.ceil(settlement.lateByMs / 60_000)} 分钟付款（6 小时内自动接受）`
				: "付款在有效期内，链上确认完成时订单已过期";
	return [
		settlement.reviewDescription === undefined
			? "✅ GMPay 自动入账（无需处理，可抽查）"
			: "✅ 客户付款复核已自动核验通过（无需处理，可抽查）",
		`订单：${describeOrder({ ...order, status: "已付款" })}`,
		`实收：${unitsToDecimal(settlement.receivedUnits, order.decimals)} ${order.asset_code}（${amountNote}）`,
		lateNote,
		`交易：${settlement.transaction.network} ${settlement.transaction.hash}`,
		settlement.reviewDescription === undefined
			? null
			: `客户说明：${settlement.reviewDescription.slice(0, 200)}`,
	]
		.filter(Boolean)
		.join("\n");
}

function describeOrder(order: OrderSummary) {
	const expected = unitsToDecimal(
		BigInt(order.expected_amount_units),
		order.decimals,
	);
	return `${order.description ?? "—"}（GMPay ${order.id}，应付 ${expected} ${order.asset_code}，状态 ${order.status}）`;
}

async function loadOrderSummary(
	db: D1Database,
	orderId: string,
	railCode?: string,
	assetCode?: string,
) {
	return db
		.prepare(
			`SELECT o.id, o.description, o.status, o.received_amount_units,
			 ops.expected_amount_units, ops.decimals, ops.asset_code
			 FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE o.id = ? AND (? IS NULL OR ops.rail_code = ?)
			 AND (? IS NULL OR ops.asset_code = ?)
			 ORDER BY ops.created_at DESC LIMIT 1`,
		)
		.bind(
			orderId,
			railCode ?? null,
			railCode ?? null,
			assetCode ?? null,
			assetCode ?? null,
		)
		.first<OrderSummary>();
}
