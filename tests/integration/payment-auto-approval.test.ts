import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { submitCheckoutTransaction } from "#/features/checkout/server/submit-transaction";
import { autoApprovePaymentReview } from "#/features/payment-reviews/server/auto-approve";
import { autoApprovalPolicy } from "#/features/payments/server/auto-approval";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import type {
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import { processScannedTransactions } from "#/server/queue";
import { applyMigrations } from "./migrations";

const HOUR = 3_600_000;

describe("automatic approval of USDT payments", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;
	let telegram: string[];
	let sequence = 0;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "payment-auto-approval" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			WEBHOOK_QUEUE: { send: async () => undefined },
			OWNER_ALERT_TELEGRAM_BOT_TOKEN: "123456:test-token-not-real",
			OWNER_ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
		} as unknown as Env;
		await seedRail(db);
	});

	beforeEach(() => {
		// The policy only covers orders created after it went live.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(autoApprovalPolicy.ordersCreatedFromMs + 12 * HOUR);
		telegram = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				telegram.push(String(JSON.parse(String(init?.body)).text));
				return Response.json({
					ok: true,
					result: { message_id: 1, date: 0, chat: { id: -1, type: "group" } },
				});
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	afterAll(async () => miniflare.dispose());

	/** A fresh receiving address per test keeps orders from competing. */
	function nextTarget() {
		sequence += 1;
		return `TAuto${String(sequence).padStart(29, "0")}`;
	}

	function nextHash() {
		sequence += 1;
		return sequence.toString(16).padStart(64, "a");
	}

	async function order(input: {
		target: string;
		expectedUnits: string;
		amountMinor?: string;
		currency?: string;
		status?: "pending" | "expired" | "cancelled";
		createdAt?: number;
		expiresAt?: number;
	}) {
		sequence += 1;
		const id = String(26110700000000000000n + BigInt(sequence));
		const now = Date.now();
		const createdAt = input.createdAt ?? now - 60_000;
		const expiresAt = input.expiresAt ?? now + 30 * 60_000;
		await db.batch([
			db
				.prepare(
					`INSERT INTO orders (id, external_order_id, status, amount_minor, currency,
					 currency_decimals, payment_asset_id, received_amount_units, description,
					 expires_at, version, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 2, 'auto-asset', '0', ?, ?, 0, ?, ?)`,
				)
				.bind(
					id,
					`shop-${id}`,
					input.status ?? "pending",
					input.amountMinor ?? "320000",
					input.currency ?? "CNY",
					`Order ${id}`,
					expiresAt,
					createdAt,
					createdAt,
				),
			db
				.prepare(
					`INSERT INTO order_payment_snapshots
					 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
					  asset_id, asset_code, decimals, target_value, connection_id,
					  adapter, required_confirmations, expected_amount_units, created_at)
					 VALUES (?, 'auto-method', 'USDT TRC20', 'tron', 'chain', 'auto-asset',
					  'USDT', 6, ?, 'auto-connection', 'tron', 20, ?, ?)`,
				)
				.bind(id, input.target, input.expectedUnits, createdAt),
			// Production keeps a collision lock per order for 24 h after expiry.
			db
				.prepare(
					`INSERT INTO receiving_method_locks (id, receiving_method_id, asset_id,
					 order_id, expected_amount_units, collision_key, expires_at, reusable_at,
					 released_at, created_at)
					 VALUES (?, 'auto-method', 'auto-asset', ?, ?, ?, ?, ?, NULL, ?)`,
				)
				.bind(
					`lock-${id}`,
					id,
					input.expectedUnits,
					`${input.target}:${input.expectedUnits}`,
					expiresAt,
					expiresAt + 24 * HOUR,
					createdAt,
				),
		]);
		return id;
	}

	function transfer(
		target: string,
		amountUnits: bigint,
		overrides: Partial<NormalizedTransaction> = {},
	): NormalizedTransaction {
		return {
			network: "tron",
			hash: nextHash(),
			eventIndex: 0,
			from: "TPayer11111111111111111111111111111",
			to: target,
			assetCode: "USDT",
			amountUnits,
			blockNumber: 100n,
			blockHash: "block",
			confirmations: 25,
			timestamp: new Date(),
			success: true,
			canonical: true,
			...overrides,
		};
	}

	async function state(id: string) {
		return db
			.prepare(
				"SELECT status, received_amount_units AS received FROM orders WHERE id = ?",
			)
			.bind(id)
			.first<{ status: string; received: string }>();
	}

	async function paymentCount(id: string) {
		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ?")
			.bind(id)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async function review(id: string, hash: string | null) {
		const reviewId = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO payment_reviews (id, order_id, status, transaction_hash, description,
				 evidence_key, evidence_content_type, evidence_size_bytes, evidence_sha256,
				 created_at, updated_at)
				 VALUES (?, ?, 'pending', ?, '已经付款了，请仔细复核', ?, 'image/png', 1, 'x', ?, ?)`,
			)
			.bind(reviewId, id, hash, `evidence/${reviewId}`, Date.now(), Date.now())
			.run();
		return reviewId;
	}

	describe("scanner", () => {
		it("settles a small overpayment (486 for 485.0353) and alerts once", async () => {
			const target = nextTarget();
			const id = await order({ target, expectedUnits: "485035300" });
			const paid = transfer(target, 486_000_000n);
			await processScannedTransactions(env, id, [paid]);
			expect(await state(id)).toEqual({
				status: "overpaid",
				received: "486000000",
			});
			expect(telegram).toHaveLength(1);
			expect(telegram[0]).toContain("GMPay 自动入账");
			expect(telegram[0]).toContain("多付 0.9647 USDT");
			// Replaying the same transfer neither double counts nor re-alerts.
			await processScannedTransactions(env, id, [paid]);
			expect(await paymentCount(id)).toBe(1);
			expect(telegram).toHaveLength(1);
			const event = await db
				.prepare(
					"SELECT type FROM webhook_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.bind(id)
				.first<{ type: string }>();
			expect(event?.type).toBe("order.overpaid");
		});

		it("settles an underpayment within 0.1 USDT only once confirmed", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "17428100",
				amountMinor: "11500",
			});
			const paid = transfer(target, 17_420_000n, { confirmations: 3 });
			await processScannedTransactions(env, id, [paid]);
			expect(await state(id)).toMatchObject({ status: "confirming" });
			expect(telegram).toHaveLength(0);
			await processScannedTransactions(env, id, [
				{ ...paid, confirmations: 20 },
			]);
			expect(await state(id)).toEqual({ status: "paid", received: "17420000" });
			expect(telegram).toHaveLength(1);
			expect(telegram[0]).toContain("少付 0.0081 USDT");
		});

		it("keeps a shortfall above 0.1 USDT partially paid", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "17428100",
				amountMinor: "11500",
			});
			await processScannedTransactions(env, id, [
				transfer(target, 17_300_000n),
			]);
			expect(await state(id)).toMatchObject({ status: "partially_paid" });
			expect(telegram).toHaveLength(0);
		});

		it("refuses an overpayment above 5 % and asks a person", async () => {
			const target = nextTarget();
			const id = await order({ target, expectedUnits: "485035300" });
			const result = await processScannedTransactions(env, id, [
				transfer(target, 600_000_000n),
			]);
			expect(result.skippedAmbiguous).toBe(1);
			expect(await state(id)).toEqual({ status: "pending", received: "0" });
			expect(telegram.join()).not.toContain("✅");
		});

		it("refuses to guess when two open orders could own the transfer", async () => {
			const target = nextTarget();
			const first = await order({
				target,
				expectedUnits: "17428100",
				amountMinor: "11500",
			});
			const second = await order({
				target,
				expectedUnits: "17428200",
				amountMinor: "11500",
				expiresAt: Date.now() - 10 * 60_000,
				status: "expired",
				createdAt: Date.now() - 50 * 60_000,
			});
			const result = await processScannedTransactions(env, first, [
				transfer(target, 17_420_000n),
			]);
			expect(result.skippedAmbiguous).toBe(1);
			expect(await paymentCount(first)).toBe(0);
			expect(await paymentCount(second)).toBe(0);
			expect(telegram.join()).not.toContain("✅");
		});

		it("refuses orders above ¥3300", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "500000000",
				amountMinor: "330001",
			});
			const result = await processScannedTransactions(env, id, [
				transfer(target, 500_500_000n),
			]);
			expect(result.skippedAmbiguous).toBe(1);
			expect(await state(id)).toMatchObject({ status: "pending" });
		});

		it("allows exactly ¥3300", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "500000000",
				amountMinor: "330000",
			});
			await processScannedTransactions(env, id, [
				transfer(target, 500_500_000n),
			]);
			expect(await state(id)).toMatchObject({ status: "overpaid" });
		});

		it("never touches orders created before the policy went live", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "485035300",
				createdAt: autoApprovalPolicy.ordersCreatedFromMs - 1,
			});
			const result = await processScannedTransactions(env, id, [
				transfer(target, 486_000_000n),
			]);
			expect(result.skippedAmbiguous).toBe(1);
			expect(await state(id)).toEqual({ status: "pending", received: "0" });
			const target2 = nextTarget();
			const late = await order({
				target: target2,
				expectedUnits: "17428100",
				amountMinor: "11500",
				status: "expired",
				createdAt: autoApprovalPolicy.ordersCreatedFromMs - 1,
				expiresAt: Date.now() - HOUR,
			});
			await processScannedTransactions(env, late, [
				transfer(target2, 17_428_100n),
			]);
			expect(await state(late)).toMatchObject({ status: "expired" });
		});

		it("refuses other currencies", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "485035300",
				currency: "USD",
				amountMinor: "48500",
			});
			const result = await processScannedTransactions(env, id, [
				transfer(target, 486_000_000n),
			]);
			expect(result.skippedAmbiguous).toBe(1);
		});

		it("accepts an exact payment two hours after expiry", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - 2 * HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			await processScannedTransactions(env, id, [
				transfer(target, 485_035_300n),
			]);
			expect(await state(id)).toMatchObject({ status: "paid" });
			expect(telegram).toHaveLength(1);
			expect(telegram[0]).toContain("订单过期后 120 分钟付款");
		});

		it("accepts a small late overpayment", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			await processScannedTransactions(env, id, [
				transfer(target, 486_000_000n),
			]);
			expect(await state(id)).toMatchObject({ status: "overpaid" });
		});

		it("holds a payment beyond the six-hour grace for review", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - 7 * HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			await processScannedTransactions(env, id, [
				transfer(target, 485_035_300n),
			]);
			expect(await state(id)).toMatchObject({ status: "expired" });
			const payment = await db
				.prepare("SELECT status FROM order_payments WHERE order_id = ?")
				.bind(id)
				.first<{ status: string }>();
			expect(payment?.status).toBe("detected");
			expect(telegram).toHaveLength(1);
			expect(telegram[0]).toContain("订单过期后才到账");
		});

		it("holds a late transfer that does not complete the order", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			await recordPaymentTransaction(env, id, transfer(target, 400_000_000n));
			expect(await state(id)).toMatchObject({ status: "expired" });
		});

		it("never settles a cancelled order", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "cancelled",
			});
			await processScannedTransactions(env, id, [
				transfer(target, 485_035_300n),
			]);
			expect(await state(id)).toMatchObject({ status: "cancelled" });
		});

		it("completes an order that expired while its payment was confirming", async () => {
			const target = nextTarget();
			const id = await order({
				target,
				expectedUnits: "485035300",
				createdAt: Date.now() - 20 * 60_000,
			});
			const paid = transfer(target, 486_000_000n, {
				confirmations: 2,
				timestamp: new Date(Date.now() - 5 * 60_000),
			});
			await processScannedTransactions(env, id, [paid]);
			expect(await state(id)).toMatchObject({ status: "confirming" });
			await db
				.prepare(
					"UPDATE orders SET status = 'expired', expires_at = ?, version = version + 1 WHERE id = ?",
				)
				.bind(Date.now() - 1000, id)
				.run();
			await processScannedTransactions(env, id, [
				{ ...paid, confirmations: 21 },
			]);
			expect(await state(id)).toMatchObject({ status: "overpaid" });
			expect(telegram.at(-1)).toContain("链上确认完成时订单已过期");
		});

		it("does not settle on a failed or reorganized transfer", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			await recordPaymentTransaction(
				env,
				id,
				transfer(target, 485_035_300n, { success: false }),
			);
			expect(await state(id)).toMatchObject({ status: "expired" });
		});
	});

	describe("customer transaction hash", () => {
		function adapters(observed: NormalizedTransaction | null) {
			return async () => [{ adapter: fixedAdapter(observed) }];
		}

		it("lets the payer complete an expired order inside the grace window", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			const paid = transfer(target, 486_000_000n);
			await expect(
				submitCheckoutTransaction(
					env,
					{ orderId: id, transactionHash: paid.hash },
					adapters(paid),
				),
			).resolves.toMatchObject({ status: "accepted", orderStatus: "overpaid" });
		});

		it("rejects someone else's transfer, a wrong chain and a wrong token", async () => {
			const target = nextTarget();
			const id = await order({ target, expectedUnits: "485035300" });
			for (const foreign of [
				transfer(nextTarget(), 486_000_000n),
				transfer(target, 486_000_000n, { network: "bsc" }),
				transfer(target, 486_000_000n, { assetCode: "USDC" }),
			])
				await expect(
					submitCheckoutTransaction(
						env,
						{ orderId: id, transactionHash: foreign.hash },
						adapters(foreign),
					),
				).resolves.not.toMatchObject({ status: "accepted" });
			expect(await paymentCount(id)).toBe(0);
		});

		it("does not let a second order claim an already attributed transfer", async () => {
			const target = nextTarget();
			const first = await order({ target, expectedUnits: "485035300" });
			const paid = transfer(target, 486_000_000n);
			await processScannedTransactions(env, first, [paid]);
			const target2 = nextTarget();
			const second = await order({
				target: target2,
				expectedUnits: "485035300",
			});
			await expect(
				submitCheckoutTransaction(
					env,
					{ orderId: second, transactionHash: paid.hash },
					adapters(paid),
				),
			).resolves.toMatchObject({ status: "mismatch" });
			expect(await paymentCount(second)).toBe(0);
		});

		it("refuses an expired order beyond the grace window", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - 7 * HOUR;
			const id = await order({
				target,
				expectedUnits: "485035300",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			const paid = transfer(target, 485_035_300n);
			await expect(
				submitCheckoutTransaction(
					env,
					{ orderId: id, transactionHash: paid.hash },
					adapters(paid),
				),
			).resolves.toMatchObject({ status: "mismatch" });
			expect(await paymentCount(id)).toBe(0);
		});
	});

	describe("payment review", () => {
		function adapters(observed: NormalizedTransaction | null) {
			return async () => [{ adapter: fixedAdapter(observed) }];
		}

		it("approves a review whose hash verifies and settles the order", async () => {
			const target = nextTarget();
			const expiresAt = Date.now() - 20 * 60_000;
			const id = await order({
				target,
				expectedUnits: "17428100",
				amountMinor: "11500",
				status: "expired",
				createdAt: expiresAt - 30 * 60_000,
				expiresAt,
			});
			const paid = transfer(target, 17_420_000n, {
				timestamp: new Date(expiresAt - 5 * 60_000),
			});
			const reviewId = await review(id, paid.hash);
			await expect(
				autoApprovePaymentReview(env, reviewId, adapters(paid)),
			).resolves.toEqual({ approved: true });
			expect(await state(id)).toMatchObject({ status: "paid" });
			const stored = await db
				.prepare(
					"SELECT status, reviewer_user_id, resolution_note FROM payment_reviews WHERE id = ?",
				)
				.bind(reviewId)
				.first<Record<string, unknown>>();
			expect(stored).toMatchObject({
				status: "approved",
				reviewer_user_id: null,
			});
			expect(String(stored?.resolution_note)).toContain("系统自动核验通过");
			expect(telegram).toHaveLength(1);
			expect(telegram[0]).toContain("付款复核已自动核验通过");
			// Running again changes nothing.
			await expect(
				autoApprovePaymentReview(env, reviewId, adapters(paid)),
			).resolves.toEqual({ approved: false });
			expect(await paymentCount(id)).toBe(1);
			expect(telegram).toHaveLength(1);
		});

		it("leaves an unconfirmed transfer for a person without recording it", async () => {
			const target = nextTarget();
			const id = await order({ target, expectedUnits: "485035300" });
			const paid = transfer(target, 486_000_000n, { confirmations: 5 });
			const reviewId = await review(id, paid.hash);
			await expect(
				autoApprovePaymentReview(env, reviewId, adapters(paid)),
			).resolves.toEqual({ approved: false });
			expect(await paymentCount(id)).toBe(0);
			expect(telegram).toHaveLength(0);
		});

		it("leaves reviews without a hash, with an unknown hash, or on old orders", async () => {
			const target = nextTarget();
			const id = await order({ target, expectedUnits: "485035300" });
			await expect(
				autoApprovePaymentReview(env, await review(id, null), adapters(null)),
			).resolves.toEqual({ approved: false });
			const target2 = nextTarget();
			const id2 = await order({ target: target2, expectedUnits: "485035300" });
			await expect(
				autoApprovePaymentReview(
					env,
					await review(id2, nextHash()),
					adapters(null),
				),
			).resolves.toEqual({ approved: false });
			const target3 = nextTarget();
			const old = await order({
				target: target3,
				expectedUnits: "17428100",
				amountMinor: "11500",
				status: "expired",
				createdAt: autoApprovalPolicy.ordersCreatedFromMs - 1,
				expiresAt: Date.now() - HOUR,
			});
			const paid = transfer(target3, 17_420_000n);
			await expect(
				autoApprovePaymentReview(
					env,
					await review(old, paid.hash),
					adapters(paid),
				),
			).resolves.toEqual({ approved: false });
			expect(await state(old)).toMatchObject({ status: "expired" });
			expect(await paymentCount(old)).toBe(0);
		});

		it("keeps the scanner away from an old order with a pending review", async () => {
			const target = nextTarget();
			const old = await order({
				target,
				expectedUnits: "17428100",
				amountMinor: "11500",
				createdAt: autoApprovalPolicy.ordersCreatedFromMs - 1,
			});
			const paid = transfer(target, 17_420_000n);
			await review(old, paid.hash);
			await processScannedTransactions(env, old, [paid]);
			expect(await paymentCount(old)).toBe(0);
		});
	});
});

function fixedAdapter(
	observed: NormalizedTransaction | null,
): PaymentAdapter<unknown> {
	return {
		id: "test",
		network: "tron",
		configSchema: {} as PaymentAdapter<unknown>["configSchema"],
		validateConfig: (value) => value,
		createPaymentTarget: async ({ address, expiresAt }) => ({
			address,
			expiresAt,
		}),
		getTransaction: async () => observed,
		findTransactions: async () => [],
		validateAddress: () => true,
		validatePayment: (payment, target, assetCode) =>
			payment.to === target.address &&
			payment.assetCode === assetCode &&
			payment.network === "tron",
		getConfirmations: async (payment) => payment.confirmations,
		healthCheck: async () => ({
			healthy: true,
			latencyMs: 0,
			checkedAt: new Date(),
		}),
		classifyError: () => "permanent",
		isRetryable: () => false,
	};
}

async function seedRail(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('auto-asset', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('auto-connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('auto-method', 'USDT TRC20', 'tron', 'address', 'TAuto', 'TAuto', 1, ?, ?)",
			)
			.bind(now, now),
	]);
}
