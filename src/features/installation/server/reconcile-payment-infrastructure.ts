import {
	initialExchangeRates,
	initialPaymentAssets,
	initialPaymentConnections,
	initialPaymentRails,
} from "#/features/payment-settings/catalog";
import {
	defaultCryptoRateSync,
	defaultFiatRateSync,
} from "#/features/payment-settings/server/exchange-rates";

export type PaymentInfrastructureReconciliation = {
	rails: number;
	assets: number;
	connections: number;
	exchangeRates: number;
	rateSyncSettings: number;
};

export async function reconcilePaymentInfrastructure(
	database: D1Database,
	now = Date.now(),
): Promise<PaymentInfrastructureReconciliation> {
	const statements: Array<{
		kind: keyof PaymentInfrastructureReconciliation;
		statement: D1PreparedStatement;
	}> = [];
	for (const rail of initialPaymentRails)
		statements.push({
			kind: "rails",
			statement: database
				.prepare(
					`INSERT OR IGNORE INTO payment_rails
					(code, name, kind, adapter, metadata, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					rail.code,
					rail.name,
					rail.kind,
					rail.adapter,
					JSON.stringify(rail.metadata),
					now,
					now,
				),
		});
	for (const rail of initialPaymentRails) {
		if (!("chainId" in rail.metadata)) continue;
		statements.push({
			kind: "rails",
			statement: database
				.prepare(
					`UPDATE payment_rails
					 SET metadata = json_set(COALESCE(metadata, '{}'), '$.chainId', ?),
					 updated_at = ?
					 WHERE code = ? AND json_extract(metadata, '$.chainId') IS NULL`,
				)
				.bind(rail.metadata.chainId, now, rail.code),
		});
	}
	for (const asset of initialPaymentAssets)
		statements.push({
			kind: "assets",
			statement: database
				.prepare(
					`INSERT OR IGNORE INTO payment_assets
					(id, rail_code, code, symbol, kind,
					 contract_address, decimals, default_confirmations, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					asset.id,
					asset.railCode,
					asset.code,
					asset.symbol,
					asset.kind,
					asset.contractAddress,
					asset.decimals,
					asset.defaultConfirmations,
					now,
					now,
				),
		});
	for (const connection of initialPaymentConnections)
		statements.push({
			kind: "connections",
			statement: database
				.prepare(
					`INSERT OR IGNORE INTO payment_ingresses
					(id, rail_code, name, type, transport, endpoint, api_key, priority,
					 enabled, health_status, block_lookback, log_block_range,
					 created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					connection.id,
					connection.railCode,
					connection.name,
					connection.type,
					"transport" in connection ? connection.transport : "http",
					connection.endpoint,
					connection.priority,
					connection.enabled,
					connection.healthStatus,
					"blockLookback" in connection ? connection.blockLookback : null,
					"logBlockRange" in connection ? connection.logBlockRange : null,
					now,
					now,
				),
		});
	for (const connection of initialPaymentConnections) {
		if (!connection.endpoint) continue;
		statements.push({
			kind: "connections",
			statement: database
				.prepare(
					`UPDATE payment_ingresses SET endpoint = ?, updated_at = ?
					 WHERE id = ? AND (endpoint IS NULL OR trim(endpoint) = '')`,
				)
				.bind(connection.endpoint, now, connection.id),
		});
	}
	for (const rate of initialExchangeRates) {
		const manual = rate.source === "manual";
		statements.push({
			kind: "exchangeRates",
			statement: database
				.prepare(
					`INSERT OR IGNORE INTO exchange_rates
					(id, category, base, quote, raw_rate, rate, source, adjustment_bps,
					 observed_at, expires_at, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
				)
				.bind(
					rate.id,
					rate.category,
					rate.base,
					rate.quote,
					rate.rate,
					rate.rate,
					rate.source,
					manual ? now : 0,
					manual ? now + 10 * 365 * 86_400_000 : 0,
					now,
					now,
				),
		});
	}
	for (const [category, configuration] of [
		["crypto", defaultCryptoRateSync],
		["fiat", defaultFiatRateSync],
	] as const)
		statements.push({
			kind: "rateSyncSettings",
			statement: database
				.prepare(
					`INSERT OR IGNORE INTO system_settings
					 (key, value, is_secret, updated_by, created_at, updated_at)
					 VALUES (?, ?, 0, NULL, ?, ?)`,
				)
				.bind(
					`rates.${category}_sync`,
					JSON.stringify(configuration),
					now,
					now,
				),
		});
	const results = await database.batch(
		statements.map(({ statement }) => statement),
	);
	const added: PaymentInfrastructureReconciliation = {
		rails: 0,
		assets: 0,
		connections: 0,
		exchangeRates: 0,
		rateSyncSettings: 0,
	};
	for (const [index, result] of results.entries()) {
		const entry = statements[index];
		if (entry) added[entry.kind] += result.meta.changes;
	}
	return added;
}
