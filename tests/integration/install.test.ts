import { verifyPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "#/db/schema";
import {
	installSystem,
	isInstalled,
} from "#/features/installation/server/install";
import { reconcilePaymentInfrastructure } from "#/features/installation/server/reconcile-payment-infrastructure";
import { initialExchangeRates } from "#/features/payment-settings/catalog";
import { testPaymentConnection } from "#/features/payment-settings/server/connection-health";
import {
	createPaymentMethodAdapters,
	loadPaymentConnectionHealthTargets,
} from "#/features/payment-settings/server/method-adapter";
import { queryPublicPaymentMethods } from "#/features/status/server/assets-query";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("system installation", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-install-test" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterAll(async () => miniflare.dispose());

	it("atomically creates the root user and an audit record only once", async () => {
		const db = drizzle(database, { schema });
		expect(await isInstalled(db)).toBe(false);
		await expect(
			installSystem(
				db,
				{
					name: "Root",
					email: "OWNER@example.com",
					password: "a-secure-password",
				},
				createInitialRuntimeConfig("https://pay.example:8443"),
			),
		).resolves.toEqual({ email: "owner@example.com", installed: true });
		expect(await isInstalled(db)).toBe(true);
		await expect(
			database
				.prepare("SELECT name FROM users LIMIT 1")
				.first<{ name: string }>(),
		).resolves.toEqual({ name: "Root" });
		const installCheckCounters = createDatastoreCounters();
		await expect(
			isInstalled(
				drizzle(instrumentD1(database, installCheckCounters), { schema }),
			),
		).resolves.toBe(true);
		expect(installCheckCounters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		await expect(
			installSystem(db, {
				name: "Second root",
				email: "second@example.com",
				password: "another-secure-password",
			}),
		).rejects.toThrow("System has already been installed");

		const state = await database
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM users) AS users,
			 (SELECT COUNT(*) FROM roles WHERE name = 'root' AND built_in = 1) AS root_roles,
			 (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'root') AS root_users,
			 (SELECT COUNT(*) FROM audit_logs WHERE action = 'system.installed') AS audits,
			 (SELECT COUNT(*) FROM system_settings WHERE key LIKE 'runtime.%') AS runtime_settings,
			 (SELECT COUNT(*) FROM payment_rails) AS payment_rails,
			 (SELECT COUNT(*) FROM payment_ingresses) AS payment_ingresses,
			 (SELECT COUNT(*) FROM payment_assets) AS payment_assets,
			 (SELECT COUNT(*) FROM receiving_methods) AS receiving_methods,
				 (SELECT COUNT(*) FROM exchange_rates) AS exchange_rates,
				 (SELECT COUNT(*) FROM telegram_bots) AS telegram_bots,
				 (SELECT COUNT(*) FROM telegram_bot_commands) AS telegram_commands,
				 (SELECT COUNT(*) FROM telegram_bot_commands, json_each(template_translations)) AS telegram_command_translations,
				 (SELECT COUNT(*) FROM system_settings WHERE key IN ('telegram.default_events','telegram.default_template_translations')) AS telegram_settings`)
			.first<Record<string, number>>();
		expect(state).toEqual({
			users: 1,
			root_roles: 1,
			root_users: 1,
			audits: 1,
			runtime_settings: 4,
			payment_rails: 12,
			payment_ingresses: 17,
			payment_assets: 29,
			receiving_methods: 0,
			exchange_rates: initialExchangeRates.length,
			telegram_bots: 0,
			telegram_commands: 4,
			telegram_command_translations: 24,
			telegram_settings: 2,
		});
		const methods = await queryPublicPaymentMethods(database);
		expect(methods.map((item) => item.code)).toEqual(
			expect.arrayContaining([
				"tron",
				"ethereum",
				"base",
				"bsc",
				"polygon",
				"xlayer",
				"ton",
				"aptos",
				"solana",
				"binance",
				"okx",
				"okpay",
			]),
		);
		expect(methods.every((item) => item.status === "implemented")).toBe(true);
		const tonAssets = await database
			.prepare(
				"SELECT code, symbol, decimals FROM payment_assets WHERE rail_code = 'ton' ORDER BY code",
			)
			.all<{ code: string; symbol: string; decimals: number }>();
		expect(tonAssets.results).toEqual([
			{ code: "GRAM", symbol: "GRAM", decimals: 9 },
			{ code: "USDT", symbol: "USDT", decimals: 6 },
		]);
		const authSecret = await database
			.prepare(
				"SELECT value FROM system_settings WHERE key = 'runtime.better_auth_secret'",
			)
			.first<{ value: string }>();
		expect(JSON.parse(authSecret?.value ?? '""')).toHaveLength(64);
		const originSettings = await database
			.prepare(
				`SELECT key, value FROM system_settings
				 WHERE key IN ('runtime.better_auth_url', 'security.allowed_hosts')
				 ORDER BY key`,
			)
			.all<{ key: string; value: string }>();
		expect(
			Object.fromEntries(
				originSettings.results.map(({ key, value }) => [
					key,
					JSON.parse(value),
				]),
			),
		).toEqual({
			"runtime.better_auth_url": "https://pay.example:8443",
			"security.allowed_hosts": ["pay.example:8443"],
		});
	});

	it("allows only one concurrent first-install request to commit", async () => {
		const isolated = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-concurrent-install" },
		});
		try {
			const isolatedDatabase = await isolated.getD1Database("DB");
			await applyMigrations(isolatedDatabase);
			const isolatedDb = drizzle(isolatedDatabase, { schema });
			const results = await Promise.allSettled([
				installSystem(isolatedDb, {
					name: "Root A",
					email: "root-a@example.com",
					password: "secure-password-a",
				}),
				installSystem(isolatedDb, {
					name: "Root B",
					email: "root-b@example.com",
					password: "secure-password-b",
				}),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected).toMatchObject({
				status: "rejected",
				reason: { code: "already_installed", status: 409 },
			});
			const state = await isolatedDatabase
				.prepare(`SELECT
				(SELECT COUNT(*) FROM users) AS users,
				(SELECT COUNT(*) FROM roles WHERE name = 'root') AS roles,
				(SELECT COUNT(*) FROM user_roles) AS assignments,
				(SELECT COUNT(*) FROM audit_logs WHERE action = 'system.installed') AS audits`)
				.first<Record<string, number>>();
			expect(state).toEqual({ users: 1, roles: 1, assignments: 1, audits: 1 });
		} finally {
			await isolated.dispose();
		}
	}, 20_000);

	it("seeds the exact implemented rail, asset, precision, and RPC policy matrix", async () => {
		const rails = await database
			.prepare(
				`SELECT code, kind, adapter FROM payment_rails WHERE kind = 'chain'
				 ORDER BY code`,
			)
			.all<{ code: string; kind: string; adapter: string }>();
		expect(rails.results).toEqual([
			{ code: "aptos", kind: "chain", adapter: "aptos" },
			{ code: "base", kind: "chain", adapter: "evm" },
			{ code: "bsc", kind: "chain", adapter: "evm" },
			{ code: "ethereum", kind: "chain", adapter: "evm" },
			{ code: "polygon", kind: "chain", adapter: "evm" },
			{ code: "solana", kind: "chain", adapter: "solana" },
			{ code: "ton", kind: "chain", adapter: "ton" },
			{ code: "tron", kind: "chain", adapter: "tron" },
			{ code: "xlayer", kind: "chain", adapter: "evm" },
		]);

		const assets = await database
			.prepare(
				`SELECT rail_code AS rail,
				 code, kind, decimals, contract_address
				 FROM payment_assets ORDER BY rail, code`,
			)
			.all<{
				rail: string;
				code: string;
				kind: "native" | "token" | "external";
				decimals: number;
				contract_address: string | null;
			}>();
		const matrix = assets.results.map(
			({ rail, code, kind, decimals }) => `${rail}:${code}:${kind}:${decimals}`,
		);
		expect(matrix).toEqual([
			"aptos:APT:native:8",
			"aptos:USDC:token:6",
			"aptos:USDT:token:6",
			"base:ETH:native:18",
			"base:USDC:token:6",
			"base:USDT:token:6",
			"binance:USDC:external:8",
			"binance:USDT:external:8",
			"bsc:BNB:native:18",
			"bsc:USDC:token:18",
			"bsc:USDT:token:18",
			"ethereum:ETH:native:18",
			"ethereum:USDC:token:6",
			"ethereum:USDT:token:6",
			"okpay:TRX:external:6",
			"okpay:USDT:external:8",
			"okx:USDC:external:8",
			"okx:USDT:external:8",
			"polygon:MATIC:native:18",
			"polygon:USDC:token:6",
			"polygon:USDT:token:6",
			"solana:SOL:native:9",
			"solana:USDC:token:6",
			"solana:USDT:token:6",
			"ton:GRAM:native:9",
			"ton:USDT:token:6",
			"tron:TRX:native:6",
			"tron:USDT:token:6",
			"xlayer:USDT:token:6",
		]);
		expect(
			assets.results.every((asset) =>
				asset.kind === "token"
					? Boolean(asset.contract_address)
					: asset.contract_address === null,
			),
		).toBe(true);

		const rpcPolicy = await database
			.prepare(
				"SELECT rail_code, transport, priority, enabled FROM payment_ingresses WHERE type = 'rpc' ORDER BY rail_code, transport",
			)
			.all<{
				rail_code: string;
				transport: string;
				priority: number;
				enabled: number;
			}>();
		expect(rpcPolicy.results).toHaveLength(14);
		expect(
			rpcPolicy.results
				.filter((node) => node.transport === "http")
				.every((node) => node.enabled === 1),
		).toBe(true);
		expect(
			rpcPolicy.results
				.filter(
					(node) => node.transport === "http" && node.rail_code === "xlayer",
				)
				.map((node) => node.priority)
				.sort((left, right) => left - right),
		).toEqual([100, 110]);
		expect(
			rpcPolicy.results
				.filter((node) => node.transport === "websocket")
				.every((node) => node.enabled === 0 && node.priority === 200),
		).toBe(true);
		const healthTargets = await loadPaymentConnectionHealthTargets(
			database,
			20,
		);
		expect(healthTargets).toHaveLength(10);
		expect(healthTargets.every((target) => target.adapter !== null)).toBe(true);
		expect(
			(await createPaymentMethodAdapters(database, "xlayer-usdt")).map(
				(candidate) => candidate.connectionId,
			),
		).toEqual(["connection-xlayer-default", "connection-xlayer-secondary"]);
		const providerEndpoints = await database
			.prepare(
				"SELECT rail_code, endpoint, enabled FROM payment_ingresses WHERE type = 'provider' ORDER BY rail_code",
			)
			.all<{ rail_code: string; endpoint: string; enabled: number }>();
		expect(providerEndpoints.results).toEqual([
			{
				rail_code: "binance",
				endpoint: "https://api-gcp.binance.com",
				enabled: 1,
			},
			{
				rail_code: "okpay",
				endpoint: "https://api.okaypay.me/shop",
				enabled: 1,
			},
			{
				rail_code: "okx",
				endpoint: "https://www.okx.com",
				enabled: 1,
			},
		]);
		await expect(
			database
				.prepare(
					"UPDATE payment_ingresses SET enabled = 0 WHERE id = 'connection-okx-default'",
				)
				.run(),
		).rejects.toThrow();
		const methodPolicy = await database
			.prepare(
				`SELECT default_confirmations, rail_code AS rail FROM payment_assets`,
			)
			.all<{
				default_confirmations: number;
				rail: string;
			}>();
		expect(methodPolicy.results).toHaveLength(29);
		expect(
			methodPolicy.results.find((method) => method.rail === "tron"),
		).toMatchObject({ default_confirmations: 20 });

		const rates = await database
			.prepare(
				"SELECT id, raw_rate, rate, source, expires_at FROM exchange_rates ORDER BY id",
			)
			.all<{
				id: string;
				raw_rate: string;
				rate: string;
				source: string;
				expires_at: number;
			}>();
		expect(rates.results).toHaveLength(initialExchangeRates.length);
		expect(rates.results.every((rate) => rate.raw_rate === rate.rate)).toBe(
			true,
		);
		expect(rates.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "rate-eth-usdt",
					raw_rate: "1869",
					rate: "1869",
					source: "binance",
					expires_at: 0,
				}),
				expect.objectContaining({
					id: "rate-usd-cny",
					raw_rate: "6.78025",
					rate: "6.78025",
				}),
			]),
		);
		expect(rates.results.map((rate) => rate.id)).not.toEqual(
			expect.arrayContaining(["rate-usd-ssp", "rate-usd-ved", "rate-usd-zwg"]),
		);
		const nativeCodes = [
			...new Set(
				assets.results
					.filter((asset) => asset.kind === "native")
					.map((asset) => asset.code),
			),
		].sort();
		const automaticBases = rates.results
			.filter((rate) => rate.source !== "manual")
			.map((rate) => rate.id.replace(/^rate-/, "").replace(/-usdt$/, ""));
		expect(automaticBases).toEqual(
			expect.arrayContaining(nativeCodes.map((code) => code.toLowerCase())),
		);
	});

	it("hashes the exact password without trimming secret characters", async () => {
		const isolated = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-exact-install-password" },
		});
		try {
			const isolatedDatabase = await isolated.getD1Database("DB");
			await applyMigrations(isolatedDatabase);
			const exactPassword = "  secure password  ";
			await installSystem(drizzle(isolatedDatabase, { schema }), {
				name: "Root",
				email: "root@example.com",
				password: exactPassword,
			});
			const credential = await isolatedDatabase
				.prepare(
					"SELECT password FROM accounts WHERE provider_id = 'credential' LIMIT 1",
				)
				.first<{ password: string }>();
			if (!credential) throw new Error("Credential account was not created");
			await expect(
				verifyPassword({ hash: credential.password, password: exactPassword }),
			).resolves.toBe(true);
			await expect(
				verifyPassword({
					hash: credential.password,
					password: exactPassword.trim(),
				}),
			).resolves.toBe(false);
		} finally {
			await isolated.dispose();
		}
	});

	it("idempotently restores missing payment defaults without overwriting operator configuration", async () => {
		await database.batch([
			database
				.prepare("DELETE FROM payment_assets WHERE id = ?")
				.bind("solana-usdc"),
			database
				.prepare("DELETE FROM exchange_rates WHERE id = ?")
				.bind("rate-sol-usdt"),
			database
				.prepare("UPDATE payment_ingresses SET name = ? WHERE id = ?")
				.bind("Operator Tron endpoint", "connection-tron-default"),
			database
				.prepare("UPDATE payment_ingresses SET enabled = 0 WHERE id = ?")
				.bind("connection-tron-default"),
			database
				.prepare("UPDATE payment_ingresses SET endpoint = NULL WHERE id = ?")
				.bind("connection-okx-default"),
			database.prepare(
				`UPDATE payment_rails
				 SET metadata = json_remove(metadata, '$.chainId')
				 WHERE code = 'polygon'`,
			),
		]);

		await expect(
			reconcilePaymentInfrastructure(database, 1_800_000_000_000),
		).resolves.toEqual({
			rails: 1,
			assets: 1,
			connections: 1,
			exchangeRates: 1,
			rateSyncSettings: 0,
		});
		await expect(
			reconcilePaymentInfrastructure(database, 1_800_000_000_001),
		).resolves.toEqual({
			rails: 0,
			assets: 0,
			connections: 0,
			exchangeRates: 0,
			rateSyncSettings: 0,
		});
		const tron = await database
			.prepare("SELECT name, enabled FROM payment_ingresses WHERE id = ?")
			.bind("connection-tron-default")
			.first<{ name: string; enabled: number }>();
		expect(tron).toEqual({ name: "Operator Tron endpoint", enabled: 0 });
		const okx = await database
			.prepare("SELECT endpoint, enabled FROM payment_ingresses WHERE id = ?")
			.bind("connection-okx-default")
			.first<{ endpoint: string; enabled: number }>();
		expect(okx).toEqual({ endpoint: "https://www.okx.com", enabled: 1 });
		const polygon = await database
			.prepare(
				"SELECT json_extract(metadata, '$.chainId') AS chain_id FROM payment_rails WHERE code = 'polygon'",
			)
			.first<{ chain_id: number }>();
		expect(polygon).toEqual({ chain_id: 137 });
		const solRate = await database
			.prepare("SELECT raw_rate, rate FROM exchange_rates WHERE id = ?")
			.bind("rate-sol-usdt")
			.first<{ raw_rate: string; rate: string }>();
		expect(solRate).toEqual({ raw_rate: "77.07", rate: "77.07" });
	});

	it("health-checks a supported chain connection before it is enabled", async () => {
		await database
			.prepare(
				"UPDATE payment_ingresses SET enabled = 0 WHERE id = 'connection-base-default'",
			)
			.run();
		const request = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json({ id: 1, jsonrpc: "2.0", result: "0x2105" }),
			);
		try {
			await expect(
				testPaymentConnection(database, "connection-base-default"),
			).resolves.toMatchObject({ healthy: true });
		} finally {
			request.mockRestore();
			await database
				.prepare(
					"UPDATE payment_ingresses SET enabled = 1 WHERE id = 'connection-base-default'",
				)
				.run();
		}
	});
});
