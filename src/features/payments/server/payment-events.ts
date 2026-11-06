import { notifyTelegram } from "#/features/telegram/server/telegram";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

export type WebhookEndpoint = {
	id: string;
	api_key_id: string;
	url: string;
	secret_encrypted: string;
};

export type WebhookDelivery = {
	id: string;
	endpoint: WebhookEndpoint;
};

export type PaymentRuntime = Pick<Env, "DB" | "WEBHOOK_QUEUE"> &
	Partial<
		Pick<
			Env,
			| "OWNER_ALERT_TELEGRAM_BOT_TOKEN"
			| "OWNER_ALERT_TELEGRAM_CHAT_ID"
			| "OWNER_ALERT_TELEGRAM_THREAD_ID"
		>
	>;

export async function matchingWebhookEndpoints(
	db: D1Database,
	orderId: string,
) {
	const endpoint = await db
		.prepare(
			`SELECT o.id, o.notify_url AS url, k.id AS api_key_id, k.secret_encrypted
		 FROM orders o JOIN api_keys k ON k.id = o.api_key_id
		 WHERE o.id = ? AND o.notify_url IS NOT NULL LIMIT 1`,
		)
		.bind(orderId)
		.first<WebhookEndpoint>();
	return endpoint ? [endpoint] : [];
}

export async function dispatchPaymentNotifications(
	env: PaymentRuntime,
	eventId: string,
	payload: Record<string, unknown>,
	deliveries: WebhookDelivery[],
	eventType: string,
) {
	const results = await Promise.allSettled([
		enqueueWebhookDeliveries(env, eventId, deliveries),
		notifyTelegram(env.DB, eventType, payload),
	]);
	if (results.some((result) => result.status === "rejected")) {
		console.warn("A persisted order notification could not be dispatched");
	}
}

export async function paymentWebhookInstance(
	db: D1Database,
	configured?: RuntimeConfig,
) {
	const runtime = configured ?? (await loadRuntimeConfig(db));
	return { name: "GMPay Edge" as const, url: runtime.betterAuthUrl };
}

async function enqueueWebhookDeliveries(
	env: Pick<PaymentRuntime, "WEBHOOK_QUEUE">,
	eventId: string,
	deliveries: WebhookDelivery[],
) {
	await Promise.all(
		deliveries.map(async ({ id }) => {
			const message: WebhookQueueMessage = {
				kind: "webhook.delivery",
				version: 1,
				deliveryId: id,
				eventId,
				attempt: 1,
			};
			await env.WEBHOOK_QUEUE.send(message);
		}),
	);
}
