import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	applyFiatRateAdjustment,
	defaultFiatRateSync,
	fetchFrankfurterRates,
	loadRateSyncConfiguration,
	refreshRateCategoryIfDue,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { runMaintenance } from "#/server/scheduled";
import { applyMigrations } from "./migrations";

const previousObservedAt = 1_799_000_000_000;

describe("keyless fiat-rate synchronization", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-fiat-rate-fallback-test" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare("DELETE FROM exchange_rates WHERE category = 'fiat'")
			.run();
		await db
			.prepare(
				`INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source,
				 adjustment_bps, observed_at, expires_at, created_at, updated_at)
				 VALUES ('rate-usd-cny', 'fiat', 'USD', 'CNY', '6.7079', '6.6743605', 'frankfurter',
				 -50, ?, ?, 1, 1)`,
			)
			.bind(previousObservedAt, previousObservedAt + 86_400_000)
			.run();
		// The stored category adjustment intentionally differs from the pair's
		// adjustment: a sync must not silently reset an existing pair.
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{ ...defaultFiatRateSync, lastSyncedAt: previousObservedAt },
			null,
			previousObservedAt,
		);
	});

	afterAll(async () => miniflare.dispose());
	afterEach(() => vi.restoreAllMocks());

	it("requests the Frankfurter USD table without credentials", async () => {
		const request = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(
				Response.json([
					{ date: "2026-10-23", base: "USD", quote: "CNY", rate: 6.6743 },
					{ date: "2026-10-23", base: "EUR", quote: "CNY", rate: 7.7 },
				]),
			),
		);
		await expect(fetchFrankfurterRates("USD", [], request)).resolves.toEqual({
			CNY: "6.6743",
		});
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.origin).toBe("https://api.frankfurter.dev");
		expect(requestedUrl.pathname).toBe("/v2/rates");
		expect(requestedUrl.searchParams.get("base")).toBe("USD");
		expect(requestedUrl.search).not.toContain("access_key");
	});

	it("leaves rates untouched and audits a visible failure when Frankfurter fails", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = previousObservedAt + 2 * 86_400_000;
		const request = vi.fn(() =>
			Promise.resolve(new Response("unavailable", { status: 503 })),
		);
		await expect(
			refreshRateCategoryIfDue(db, "fiat", request, now),
		).rejects.toThrow("Rate synchronization failed for 1 pair(s)");
		expect(request).toHaveBeenCalledOnce();
		await expect(
			db
				.prepare(
					"SELECT raw_rate, rate, source, adjustment_bps, observed_at FROM exchange_rates WHERE id = 'rate-usd-cny'",
				)
				.first(),
		).resolves.toEqual({
			raw_rate: "6.7079",
			rate: "6.6743605",
			source: "frankfurter",
			adjustment_bps: -50,
			observed_at: previousObservedAt,
		});
		await expect(loadRateSyncConfiguration(db, "fiat")).resolves.toMatchObject({
			lastSyncedAt: previousObservedAt,
		});
		const audit = await db
			.prepare(
				"SELECT actor_user_id, after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(now)
			.first<{ actor_user_id: string | null; after: string }>();
		expect(audit?.actor_user_id).toBeNull();
		expect(JSON.parse(audit?.after ?? "{}")).toEqual({
			configured: 1,
			updated: 0,
			failed: 1,
			failures: [
				{
					id: "fiat",
					pair: "USD/fiat",
					source: "frankfurter",
					code: "http_503",
				},
			],
		});
		expect([...warn.mock.calls, ...info.mock.calls].flat()).toContainEqual(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "frankfurter",
				operation: "sync_fiat_rates",
				outcome: "failure",
			}),
		);
	});

	it("uses Frankfurter on the scheduled path and preserves each pair's adjustment", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = previousObservedAt + 3 * 86_400_000;
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json([
					{ date: "2026-10-23", base: "USD", quote: "CNY", rate: 6.6743 },
					{ date: "2026-10-23", base: "USD", quote: "JPY", rate: 151.2 },
				]),
			),
		);
		await expect(
			refreshRateCategoryIfDue(db, "fiat", request, now),
		).resolves.toMatchObject({ configured: 2, updated: 2, failed: 0 });
		expect(new URL(String(request.mock.calls[0]?.[0])).hostname).toBe(
			"api.frankfurter.dev",
		);
		const rows = await db
			.prepare(
				"SELECT quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all();
		expect(rows.results).toEqual([
			{
				quote: "CNY",
				raw_rate: "6.6743",
				rate: "6.6409285",
				source: "frankfurter",
				adjustment_bps: -50,
				observed_at: now,
				expires_at: now + 86_400_000,
			},
			{
				quote: "JPY",
				raw_rate: "151.2",
				rate: "151.2",
				source: "frankfurter",
				adjustment_bps: 0,
				observed_at: now,
				expires_at: now + 86_400_000,
			},
		]);
		await expect(loadRateSyncConfiguration(db, "fiat")).resolves.toMatchObject({
			lastSyncedAt: now,
		});
		await expect(
			refreshRateCategoryIfDue(db, "fiat", request, now + 60_000),
		).resolves.toBeNull();
		expect(request).toHaveBeenCalledOnce();
	});

	it("re-applies an explicitly changed category adjustment to stored pairs", async () => {
		await applyFiatRateAdjustment(db, -100, previousObservedAt + 4);
		await expect(
			db
				.prepare(
					"SELECT quote, raw_rate, rate, adjustment_bps FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
				)
				.all(),
		).resolves.toMatchObject({
			results: [
				{
					quote: "CNY",
					raw_rate: "6.6743",
					rate: "6.607557",
					adjustment_bps: -100,
				},
				{
					quote: "JPY",
					raw_rate: "151.2",
					rate: "149.688",
					adjustment_bps: -100,
				},
			],
		});
	});

	it("dispatches the due fiat sync from Cron without exchangerate.host credentials", async () => {
		const now = Date.now();
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{ ...defaultFiatRateSync, lastSyncedAt: null },
			null,
			now,
		);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"* * * * *",
			{ expire: vi.fn(), recoverWebhooks: vi.fn() },
			now,
		);
		expect(sendBatch.mock.calls.flat(2)).toContainEqual({
			body: { kind: "payment.rate_sync", version: 1, category: "fiat" },
		});
	});

	it("audits a failed sync even before any fiat pair exists", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		await db
			.prepare("DELETE FROM exchange_rates WHERE category = 'fiat'")
			.run();
		const now = previousObservedAt + 5 * 86_400_000;
		await expect(
			refreshRateCategoryIfDue(
				db,
				"fiat",
				() => Promise.resolve(Response.json([])),
				now,
				{ ...defaultFiatRateSync, lastSyncedAt: null },
			),
		).rejects.toThrow("Rate synchronization failed");
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(now)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "{}")).toMatchObject({
			configured: 0,
			failed: 1,
			failures: [{ source: "frankfurter", code: "provider_error" }],
		});
	});
});
