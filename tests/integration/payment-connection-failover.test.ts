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

	it("keeps a throttled connection routable while failing over", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL",
			)
			.run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("primary"))
					return new Response("slow down", { status: 429 });
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
				retry: () => undefined,
			} as unknown as Message<
				import("#/features/payments/types").PaymentScanMessage
			>,
			{ DB: db } as Env,
		);
		expect(acknowledged).toBe(true);
		const primary = await db
			.prepare(
				"SELECT health_status FROM payment_ingresses WHERE id = 'connection-primary'",
			)
			.first<{ health_status: string }>();
		expect(primary?.health_status).toBe("healthy");
	});

	it("does not attribute a downstream D1 failure to the provider or fail over", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL",
			)
			.run();
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
