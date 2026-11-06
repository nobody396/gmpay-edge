import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	alertPaymentReviewSubmitted,
	alertUnattributedPayment,
	type OwnerAlertEnv,
} from "#/features/payments/server/owner-alert";
import { retainUnattributedPayment } from "#/features/payments/server/unattributed";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { applyMigrations } from "./migrations";

const orderId = "26110620374812345678";
const address = "T111111111111111111111111111111111";

describe("owner payment alerts", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "owner-payment-alerts" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	function telegram() {
		const sent: Array<Record<string, unknown>> = [];
		const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)));
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						message_id: 1,
						date: 0,
						chat: { id: -100, type: "supergroup" },
					},
				}),
			);
		}) as unknown as typeof fetch;
		return { sent, request };
	}

	function env(configured = true): OwnerAlertEnv {
		return {
			DB: db,
			...(configured
				? {
						OWNER_ALERT_TELEGRAM_BOT_TOKEN: "123456:test-token-not-real",
						OWNER_ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
						OWNER_ALERT_TELEGRAM_THREAD_ID: "5",
					}
				: {}),
		};
	}

	const transfer: NormalizedTransaction = {
		network: "tron",
		hash: "409f03d974fccd0df5e57b10199e81ca1352ac3153c556f552a48eadeeb53ac6",
		eventIndex: 0,
		from: "TEYupz6iZqsjMTerikSJewuCCQVGroqzqg",
		to: address,
		assetCode: "USDT",
		amountUnits: 486_000_000n,
		blockNumber: 100n,
		blockHash: "block",
		confirmations: 5,
		timestamp: new Date(),
		success: true,
	};

	it("retains a transfer once so the scanner alerts exactly once", async () => {
		expect(
			await retainUnattributedPayment(
				db,
				transfer,
				"payment_amount_review_required",
			),
		).toBe(true);
		expect(
			await retainUnattributedPayment(
				db,
				transfer,
				"payment_amount_review_required",
			),
		).toBe(false);
	});

	it("describes an inexact transfer with its likely order", async () => {
		const { sent, request } = telegram();
		expect(
			await alertUnattributedPayment(
				env(),
				transfer,
				"payment_amount_review_required",
				orderId,
				request,
			),
		).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.chat_id).toBe("-1001234567890");
		expect(sent[0]?.message_thread_id).toBe(5);
		const text = String(sent[0]?.text);
		expect(text).toContain("金额和订单应付不一致");
		expect(text).toContain("收到：486 USDT（tron）");
		expect(text).toContain("Order GMTEST");
		expect(text).toContain("应付 485.0353 USDT");
		expect(text).toContain(transfer.hash);
	});

	it("describes a customer review submission", async () => {
		const { sent, request } = telegram();
		await alertPaymentReviewSubmitted(
			env(),
			{ orderId, description: "已经付款了，请仔细复核" },
			request,
		);
		const text = String(sent[0]?.text);
		expect(text).toContain("客户提交了付款复核");
		expect(text).toContain("GMPay 26110620374812345678");
		expect(text).toContain("交易：客户未填写");
		expect(text).toContain("已经付款了，请仔细复核");
	});

	it("is a silent no-op when the channel is not configured or Telegram fails", async () => {
		const { request } = telegram();
		expect(
			await alertPaymentReviewSubmitted(
				env(false),
				{ orderId, description: "x".repeat(20) },
				request,
			),
		).toBe(false);
		expect(request).not.toHaveBeenCalled();
		const failing = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(
			await alertPaymentReviewSubmitted(
				env(),
				{ orderId, description: "x".repeat(20) },
				failing,
			),
		).toBe(false);
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('alert-asset', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('alert-connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('alert-method', 'Primary USDT', 'tron', 'address', ?, ?, 1, ?, ?)",
			)
			.bind(address, address, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, description, expires_at, version, created_at, updated_at) VALUES (?, 'alert-order', 'pending', '320000', 'CNY', 2, 'alert-asset', '0', 'Order GMTEST', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, target_value, connection_id,
				  adapter, required_confirmations, expected_amount_units, created_at)
				 VALUES (?, 'alert-method', 'Primary USDT', 'tron', 'chain',
				  'alert-asset', 'USDT', 6, ?, 'alert-connection',
				  'tron', 20, '485035300', ?)`,
			)
			.bind(orderId, address, now),
	]);
}
