import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadOperationalSettings } from "#/server/operational-settings";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("authoritative operational settings", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-operational-settings" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	beforeEach(async () => {
		await database
			.prepare(
				`DELETE FROM system_settings WHERE key IN (
				 'orders.default_expiry_ms', 'orders.max_expiry_ms',
					 'payments.late_payment_policy', 'webhooks.max_attempts',
					 'webhooks.timeout_ms', 'webhooks.dns_failure_policy',
					 'payments.scan_batch_size',
					 'payments.scan_interval_ms',
					 'payments.webhook_recovery_interval_ms',
					 'payments.rpc_health_interval_ms', 'payments.reorg_monitor_ms',
				 'retention.audit_ms'
				)`,
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("observes each committed D1 update without cache invalidation", async () => {
		await putSetting("orders.default_expiry_ms", 120_000);
		const counters = createDatastoreCounters();
		const countedDatabase = instrumentD1(database, counters);

		await expect(
			loadOperationalSettings(countedDatabase),
		).resolves.toMatchObject({
			defaultExpiryMs: 120_000,
		});
		await putSetting("orders.default_expiry_ms", 180_000);
		await expect(
			loadOperationalSettings(countedDatabase),
		).resolves.toMatchObject({
			defaultExpiryMs: 180_000,
		});

		expect(counters.d1StatementAll).toBe(2);
		expect(counters.kvGet).toBe(0);
		expect(counters.kvPut).toBe(0);
	});

	it("keeps valid values and falls back per field for malformed or unsafe rows", async () => {
		await Promise.all([
			putRawSetting("orders.default_expiry_ms", "1000"),
			putSetting("orders.max_expiry_ms", 600_000),
			putSetting("payments.late_payment_policy", "invalid"),
			putSetting("webhooks.max_attempts", 999),
			putRawSetting("webhooks.timeout_ms", "not-json"),
			putSetting("payments.scan_batch_size", 25),
		]);

		await expect(loadOperationalSettings(database)).resolves.toMatchObject({
			defaultExpiryMs: 900_000,
			maxExpiryMs: 86_400_000,
			latePaymentPolicy: "review",
			webhookMaxAttempts: 8,
			webhookTimeoutMs: 10_000,
			webhookDnsFailurePolicy: "reject",
			paymentScanBatchSize: 25,
			webhookRecoveryIntervalMs: 900_000,
			rpcHealthIntervalMs: 900_000,
		});
	});

	it("fails closed when authoritative D1 is unavailable", async () => {
		const unavailable = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						throw new Error("D1 unavailable");
					},
				}),
			}),
		} as unknown as D1Database;

		await expect(loadOperationalSettings(unavailable)).rejects.toThrow(
			"D1 unavailable",
		);
	});

	async function putSetting(key: string, value: unknown) {
		return putRawSetting(key, JSON.stringify(value));
	}

	async function putRawSetting(key: string, value: string) {
		const now = Date.now();
		await database
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, updated_by, created_at, updated_at)
				 VALUES (?, ?, 0, NULL, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
				 updated_at = excluded.updated_at`,
			)
			.bind(key, value, now, now)
			.run();
	}
});
