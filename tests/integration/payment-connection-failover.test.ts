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
import { handlePaymentScan } from "#/server/queue";
import { applyMigrations } from "./migrations";

describe("payment connection failover", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-connection-failover" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	afterAll(async () => miniflare.dispose());

	it("tries the next enabled connection and updates health without failing the order", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push(url);
				if (url.includes("primary"))
					return new Response("offline", { status: 503 });
				const request = JSON.parse(String(init?.body)) as { method: string };
				if (request.method === "eth_blockNumber") return rpc("0xa");
				if (request.method === "eth_getBlockByNumber")
					return rpc({
						hash: "0xblock",
						number: "0xa",
						timestamp: "0x6553f100",
						transactions: [],
					});
				throw new Error(`Unexpected RPC method ${request.method}`);
			}),
		);
		let acknowledged = false;
		let retried = false;
		await handlePaymentScan(
			{
				body: {
					kind: "payment.scan",
					version: 1,
					receivingMethodId: "asset-eth",
					orderId: "order-eth",
				},
				ack: () => {
					acknowledged = true;
				},
				retry: () => {
					retried = true;
				},
			} as unknown as Message<
				import("#/features/payments/types").PaymentScanMessage
			>,
			{ DB: db } as Env,
		);
		expect({ acknowledged, retried }).toEqual({
			acknowledged: true,
			retried: false,
		});
		expect(calls[0]).toBe("https://primary.example");
		expect(calls.slice(1)).not.toHaveLength(0);
		expect(
			calls.slice(1).every((url) => url === "https://fallback.example"),
		).toBe(true);
		const health = await db
			.prepare(
				"SELECT id, health_status, last_error_code FROM payment_ingresses ORDER BY priority",
			)
			.all<{
				id: string;
				health_status: string;
				last_error_code: string | null;
			}>();
		expect(health.results).toEqual([
			{
				id: "connection-primary",
				health_status: "unhealthy",
				last_error_code: "network",
			},
			{
				id: "connection-fallback",
				health_status: "healthy",
				last_error_code: null,
			},
		]);
		const order = await db
			.prepare("SELECT status FROM orders WHERE id = 'order-eth'")
			.first<{ status: string }>();
		expect(order?.status).toBe("pending");
		const metrics = info.mock.calls
			.map(([record]) => record)
			.filter(
				(record): record is Record<string, unknown> =>
					typeof record === "object" &&
					record !== null &&
					record.event === "provider_operation" &&
					record.operation === "payment_scan",
			);
		expect(metrics).toEqual([
			expect.objectContaining({
				adapter: "evm",
				outcome: "failure",
				errorCode: "network",
				failoverCount: 1,
			}),
			expect.objectContaining({
				adapter: "evm",
				outcome: "success",
				status: "empty",
				failoverCount: 1,
			}),
		]);
	});

	it("checks the next connection when the primary reports no payment", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		await db.batch([
			db.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL",
			),
			db.prepare(
				"UPDATE orders SET status = 'pending', received_amount_units = '0', paid_at = NULL, payment_scan_cursor = NULL, version = 0 WHERE id = 'order-eth'",
			),
			db.prepare("DELETE FROM order_payments WHERE order_id = 'order-eth'"),
			db.prepare(
				"DELETE FROM blockchain_transactions WHERE network = 'ethereum'",
			),
			db.prepare("DELETE FROM webhook_events WHERE order_id = 'order-eth'"),
		]);

		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push(url);
				const request = JSON.parse(String(init?.body)) as {
					method: string;
					params: string[];
				};
				if (request.method === "eth_blockNumber") return rpc("0xa");
				if (request.method === "eth_getBlockByNumber") {
					const blockNumber = request.params[0];
					if (!blockNumber) throw new Error("Expected a block number");
					const hasPayment = url.includes("fallback") && blockNumber === "0x9";
					return rpc({
						hash: `0xblock${blockNumber.slice(2)}`,
						number: blockNumber,
						timestamp: "0x6553f100",
						transactions: hasPayment
							? [
									{
										blockHash: "0xblock9",
										blockNumber: "0x9",
										from: "0x2222222222222222222222222222222222222222",
										hash: "0xdelayedpayment",
										to: "0x1111111111111111111111111111111111111111",
										value: "0xde0b6b3a7640000",
									},
								]
							: [],
					});
				}
				if (request.method === "eth_getTransactionReceipt")
					return rpc({
						blockHash: "0xblock9",
						blockNumber: "0x9",
						logs: [],
						status: "0x1",
						transactionHash: "0xdelayedpayment",
					});
				throw new Error(`Unexpected RPC method ${request.method}`);
			}),
		);

		const ack = vi.fn();
		const retry = vi.fn();
		await handlePaymentScan(
			{
				body: {
					kind: "payment.scan",
					version: 1,
					receivingMethodId: "asset-eth",
					orderId: "order-eth",
				},
				ack,
				retry,
			} as unknown as Message<
				import("#/features/payments/types").PaymentScanMessage
			>,
			{ DB: db } as Env,
		);

		expect(calls.some((url) => url.includes("fallback"))).toBe(true);
		expect(retry).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledOnce();
		await expect(
			db
				.prepare(
					"SELECT status, received_amount_units FROM orders WHERE id = 'order-eth'",
				)
				.first(),
		).resolves.toMatchObject({
			status: "paid",
			received_amount_units: "1000000000000000000",
		});
	});

	it("does not attribute a downstream D1 failure to the provider or fail over", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		await db.batch([
			db.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL",
			),
			db.prepare(
				"UPDATE orders SET status = 'pending', received_amount_units = '0', paid_at = NULL, payment_scan_cursor = NULL, version = 0 WHERE id = 'order-eth'",
			),
			db.prepare("DELETE FROM order_payments WHERE order_id = 'order-eth'"),
			db.prepare(
				"DELETE FROM blockchain_transactions WHERE network = 'ethereum'",
			),
		]);
		await db
			.prepare(
				`CREATE TRIGGER reject_healthy_connection_update
			 BEFORE UPDATE OF health_status ON payment_ingresses
			 WHEN NEW.health_status = 'healthy'
			 BEGIN SELECT RAISE(FAIL, 'simulated downstream D1 failure'); END`,
			)
			.run();
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				calls.push(String(input));
				const request = JSON.parse(String(init?.body)) as { method: string };
				if (request.method === "eth_blockNumber") return rpc("0xa");
				if (request.method === "eth_getBlockByNumber")
					return rpc({
						hash: "0xblock",
						number: "0xa",
						timestamp: "0x6553f100",
						transactions: [],
					});
				throw new Error(`Unexpected RPC method ${request.method}`);
			}),
		);
		try {
			await expect(
				handlePaymentScan(
					{
						body: {
							kind: "payment.scan",
							version: 1,
							receivingMethodId: "asset-eth",
							orderId: "order-eth",
						},
						ack: vi.fn(),
						retry: vi.fn(),
					} as unknown as Message<
						import("#/features/payments/types").PaymentScanMessage
					>,
					{ DB: db } as Env,
				),
			).rejects.toThrow("simulated downstream D1 failure");
		} finally {
			await db.prepare("DROP TRIGGER reject_healthy_connection_update").run();
		}

		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((url) => url === "https://primary.example")).toBe(true);
		const metrics = info.mock.calls
			.map(([record]) => record)
			.filter(
				(record): record is Record<string, unknown> =>
					typeof record === "object" &&
					record !== null &&
					record.event === "provider_operation" &&
					record.operation === "payment_scan",
			);
		expect(metrics).toEqual([
			expect.objectContaining({
				adapter: "evm",
				outcome: "success",
				failoverCount: 0,
			}),
		]);
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('ethereum', 'Ethereum', 'chain', 'evm', 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-eth', 'ethereum', 'ETH', 'ETH', 'native', 18, 1, 1)",
		),
		db.prepare(
			`INSERT OR IGNORE INTO payment_rails
			 (code, name, kind, adapter, metadata, created_at, updated_at)
			 VALUES ('ethereum', 'Ethereum', 'chain', 'evm', '{"nativeSymbol":"ETH"}', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO payment_ingresses
			 (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at)
			 VALUES
			 ('connection-primary', 'ethereum', 'Primary', 'rpc', 'https://primary.example', 1, 1, 'healthy', 1, 1),
			 ('connection-fallback', 'ethereum', 'Fallback', 'rpc', 'https://fallback.example', 2, 1, 'healthy', 1, 1)`,
		),
		db.prepare(
			"UPDATE payment_assets SET default_confirmations = 2, created_at = 1, updated_at = 1 WHERE id = 'asset-eth'",
		),
		db.prepare(
			"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('asset-eth', 'Primary ETH', 'ethereum', 'address', '0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111', 1, 1, 1)",
		),
		db.prepare(
			`INSERT INTO orders
			 (id, external_order_id, status, amount_minor, currency, currency_decimals,
			  payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at)
			 VALUES ('order-eth', 'merchant-eth', 'pending', '1', 'ETH', '1',
			 'asset-eth', '0', 9999999999999, 0, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO order_payment_snapshots
			 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
			 asset_id, asset_code, decimals, target_value, connection_id, adapter,
			 required_confirmations, expected_amount_units, created_at)
			 VALUES ('order-eth', 'asset-eth', 'Primary ETH', 'ethereum', 'chain',
			 'asset-eth', 'ETH', 18, '0x1111111111111111111111111111111111111111',
			 'connection-primary', 'evm', 2, '1000000000000000000', 1)`,
		),
	]);
}

function rpc(result: unknown) {
	return Response.json({ jsonrpc: "2.0", id: 1, result });
}
