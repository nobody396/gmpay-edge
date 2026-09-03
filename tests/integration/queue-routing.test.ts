import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleQueue } from "#/server/queue";
import {
	createMerchantWebhookFetcher,
	queueMessageKind,
} from "#/server/queue/routing";
import { applyMigrations } from "./migrations";

describe("Cloudflare Queue envelope rejection", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-queue-routing" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterAll(async () => miniflare.dispose());

	it("audits only safe envelope metadata before acknowledging a rejected message", async () => {
		const ack = vi.fn();
		const retry = vi.fn();
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const message = {
			id: "queue-message-invalid-v2",
			timestamp: new Date(Date.now() - 250),
			attempts: 1,
			body: {
				kind: "payment.scan",
				version: 2,
				channelId: "channel-a",
				secret: "must-not-enter-audit",
			},
			ack,
			retry,
		};
		let records: Array<Record<string, unknown>> = [];
		try {
			await handleQueue(
				{
					queue: "gmpay-edge-payments",
					messages: [message],
				} as unknown as Parameters<typeof handleQueue>[0],
				{ DB: database } as Env,
			);
			records = info.mock.calls.map(([value]) => JSON.parse(String(value)));
		} finally {
			info.mockRestore();
		}

		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
		const audit = await database
			.prepare(
				"SELECT action, target_type, target_id, after FROM audit_logs WHERE target_id = ?",
			)
			.bind(message.id)
			.first<{
				action: string;
				target_type: string;
				target_id: string;
				after: string;
			}>();
		expect(audit).toMatchObject({
			action: "queue.message_rejected",
			target_type: "queue_message",
			target_id: message.id,
		});
		expect(JSON.parse(audit?.after ?? "null")).toEqual({
			kind: "payment.scan",
			version: 2,
			reason: "invalid_or_unsupported_envelope",
		});
		expect(audit?.after).not.toContain("must-not-enter-audit");
		expect(records).toEqual([
			expect.objectContaining({
				event: "queue_invocation_completed",
				invocationId: expect.any(String),
				queue: "gmpay-edge-payments",
				batchSize: 1,
				processedMessages: 1,
				dedupeCount: 0,
				maxBusinessConcurrency: 2,
				oldestMessageAgeMs: expect.any(Number),
				maxAttempts: 1,
				durationMs: expect.any(Number),
				outcome: "ok",
			}),
		]);
		expect(JSON.stringify(records)).not.toContain("must-not-enter-audit");
	});

	it.each([
		["gmpay-edge-payments", 2],
		["gmpay-edge-webhooks", 5],
		["unknown-queue", 3],
	])("limits %s message processing to %i", async (queue, expected) => {
		let active = 0;
		let maximum = 0;
		const database = {
			prepare: () => ({
				bind: () => ({
					run: async () => {
						active += 1;
						maximum = Math.max(maximum, active);
						await new Promise((resolve) => setTimeout(resolve, 5));
						active -= 1;
					},
				}),
			}),
		} as unknown as D1Database;
		const messages = Array.from({ length: 8 }, (_, index) => ({
			id: `invalid-${index}`,
			timestamp: new Date(),
			attempts: 1,
			body: { kind: "invalid", version: 1 },
			ack: vi.fn(),
			retry: vi.fn(),
		}));

		await handleQueue(
			{ queue, messages } as unknown as Parameters<typeof handleQueue>[0],
			{ DB: database } as Env,
		);

		expect(maximum).toBe(expected);
		expect(
			messages.every((message) => message.ack.mock.calls.length === 1),
		).toBe(true);
	});

	it("loads operational and runtime settings once for a valid batch", async () => {
		let settingsQueries = 0;
		const countedDatabase = {
			prepare(query: string) {
				if (query.includes("FROM system_settings")) settingsQueries += 1;
				return database.prepare(query);
			},
			batch: database.batch.bind(database),
		} as unknown as D1Database;
		const messages = Array.from({ length: 6 }, (_, index) => ({
			id: `webhook-${index}`,
			timestamp: new Date(),
			attempts: 1,
			body: {
				kind: "webhook.delivery",
				version: 1,
				deliveryId: `missing-delivery-${index}`,
				eventId: `missing-event-${index}`,
				attempt: 1,
			},
			ack: vi.fn(),
			retry: vi.fn(),
		}));

		await handleQueue(
			{
				queue: "gmpay-edge-webhooks",
				messages,
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: countedDatabase } as Env,
		);

		expect(settingsQueries).toBe(2);
		expect(
			messages.every((message) => message.ack.mock.calls.length === 1),
		).toBe(true);
	});

	it("merges duplicate payment scans for the same order and receiving method", async () => {
		let paymentQueries = 0;
		const countedDatabase = {
			prepare(query: string) {
				if (query.includes("FROM order_payment_snapshots")) paymentQueries += 1;
				return database.prepare(query);
			},
			batch: database.batch.bind(database),
		} as unknown as D1Database;
		const messages = Array.from({ length: 3 }, (_, index) => ({
			id: `duplicate-payment-${index}`,
			timestamp: new Date(),
			attempts: index + 1,
			body: {
				kind: "payment.scan",
				version: 1,
				orderId: "missing-order",
				receivingMethodId: "same-receiving-method",
			},
			ack: vi.fn(),
			retry: vi.fn(),
		}));

		await handleQueue(
			{
				queue: "gmpay-edge-payments",
				messages,
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: countedDatabase } as Env,
		);

		expect(paymentQueries).toBe(1);
		expect(
			messages.every((message) => message.ack.mock.calls.length === 1),
		).toBe(true);
		expect(
			messages.every((message) => message.retry.mock.calls.length === 0),
		).toBe(true);
	});

	it("rejects a valid envelope delivered to the wrong queue", async () => {
		const ack = vi.fn();
		const message = {
			id: "webhook-on-payment-queue",
			timestamp: new Date(),
			attempts: 1,
			body: {
				kind: "webhook.delivery",
				version: 1,
				deliveryId: "delivery-a",
				eventId: "event-a",
				attempt: 1,
			},
			ack,
			retry: vi.fn(),
		};

		await handleQueue(
			{
				queue: "gmpay-edge-payments",
				messages: [message],
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: database } as Env,
		);

		expect(ack).toHaveBeenCalledOnce();
		const audit = await database
			.prepare("SELECT after FROM audit_logs WHERE target_id = ?")
			.bind(message.id)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "null")).toMatchObject({
			kind: "webhook.delivery",
			reason: "wrong_queue",
		});
	});

	it("accepts only the ID-only provider event envelope", () => {
		expect(
			queueMessageKind({
				kind: "payment.provider_event",
				version: 1,
				eventId: "event-a",
			}),
		).toBe("payment");
		expect(
			queueMessageKind({
				kind: "payment.provider_event",
				version: 1,
				eventId: "event-a",
				trigger: { transactionHash: "must-not-traverse-queue" },
			}),
		).toBe("invalid");
		expect(
			queueMessageKind({
				kind: "payment.provider_event",
				version: 2,
				eventId: "event-a",
			}),
		).toBe("invalid");
	});

	it("accepts bounded payment-maintenance envelopes", () => {
		expect(
			queueMessageKind({
				kind: "payment.rate_sync",
				version: 1,
				category: "crypto",
			}),
		).toBe("payment");
		expect(
			queueMessageKind({
				kind: "payment.rpc_health",
				version: 1,
				connectionIds: ["connection-a", "connection-b"],
			}),
		).toBe("payment");
		expect(
			queueMessageKind({
				kind: "payment.event_source_reconcile",
				version: 1,
				sourceId: "source-a",
			}),
		).toBe("payment");
		expect(
			queueMessageKind({
				kind: "payment.rpc_health",
				version: 1,
				connectionIds: Array.from({ length: 21 }, (_, index) => `id-${index}`),
			}),
		).toBe("invalid");
		expect(
			queueMessageKind({
				kind: "payment.rate_sync",
				version: 1,
				category: "crypto",
				apiKey: "must-not-traverse-queue",
			}),
		).toBe("invalid");
	});

	it("consumes a due rate-sync message through the payment Queue", async () => {
		const ack = vi.fn();
		const retry = vi.fn();
		await handleQueue(
			{
				queue: "gmpay-edge-payments",
				messages: [
					{
						id: "rate-sync-crypto",
						timestamp: new Date(),
						attempts: 1,
						body: {
							kind: "payment.rate_sync",
							version: 1,
							category: "crypto",
						},
						ack,
						retry,
					},
				],
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: database } as Env,
		);

		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
	});

	it("consumes a bounded RPC-health batch through the payment Queue", async () => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('queue-health', 'Queue Health', 'chain', 'unsupported', ?, ?)",
				)
				.bind(now, now),
			database
				.prepare(
					"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('queue-health-asset', 'queue-health', 'QH', 'QH', 'native', 6, ?, ?)",
				)
				.bind(now, now),
			database
				.prepare(
					"INSERT INTO payment_ingresses (id, rail_code, name, type, priority, enabled, health_status, created_at, updated_at) VALUES ('queue-health-connection', 'queue-health', 'Queue Health', 'rpc', 1, 1, 'unknown', ?, ?)",
				)
				.bind(now, now),
		]);
		const ack = vi.fn();
		const retry = vi.fn();

		await handleQueue(
			{
				queue: "gmpay-edge-payments",
				messages: [
					{
						id: "rpc-health",
						timestamp: new Date(),
						attempts: 1,
						body: {
							kind: "payment.rpc_health",
							version: 1,
							connectionIds: ["queue-health-connection"],
						},
						ack,
						retry,
					},
				],
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: database } as Env,
		);

		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
		const connection = await database
			.prepare(
				"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = 'queue-health-connection'",
			)
			.first<{ health_status: string; last_error_code: string | null }>();
		expect(connection).toEqual({
			health_status: "unhealthy",
			last_error_code: "configuration",
		});
	});
});

describe("merchant webhook routing", () => {
	it.each([
		"https://laoshirenvip.com/api/shop/payments/provider/webhook",
		"https://gmshop-edge.laoshirenai.workers.dev/api/shop/payments/provider/webhook",
	])("routes the owned GMShop callback through its service binding", async (url) => {
		const publicFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("public"));
		const gmshopFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok"));
		const fetcher = createMerchantWebhookFetcher(
			{ fetch: gmshopFetch } as unknown as Fetcher,
			publicFetch,
		);

		const response = await fetcher(url, { method: "POST", body: "{}" });

		expect(await response.text()).toBe("ok");
		expect(gmshopFetch).toHaveBeenCalledOnce();
		expect(publicFetch).not.toHaveBeenCalled();
		const [request] = gmshopFetch.mock.calls[0] ?? [];
		expect(request).toBeInstanceOf(Request);
		expect((request as Request).url).toBe(url);
	});

	it("keeps unrelated merchant callbacks on public fetch", async () => {
		const publicFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("external"));
		const gmshopFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("wrong"));
		const fetcher = createMerchantWebhookFetcher(
			{ fetch: gmshopFetch } as unknown as Fetcher,
			publicFetch,
		);

		const response = await fetcher("https://merchant.example/webhook");

		expect(await response.text()).toBe("external");
		expect(publicFetch).toHaveBeenCalledOnce();
		expect(gmshopFetch).not.toHaveBeenCalled();
	});
});
