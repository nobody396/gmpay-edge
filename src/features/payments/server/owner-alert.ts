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
