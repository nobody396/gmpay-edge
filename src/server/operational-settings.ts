import { z } from "zod";

export const immediateReleaseModeSql =
	"COALESCE((SELECT json_extract(value, '$') FROM system_settings WHERE key = 'orders.immediate_release_mode'), 0)";

type OperationalSettings = {
	immediateReleaseMode: boolean;
	fixedExpiryMs: number;
	defaultExpiryMs: number;
	maxExpiryMs: number;
	latePaymentPolicy: "accept" | "review" | "reject";
	webhookMaxAttempts: number;
	webhookTimeoutMs: number;
	webhookDnsFailurePolicy: "reject" | "deliver";
	paymentScanBatchSize: number;
	paymentScanIntervalMs: number;
	webhookRecoveryIntervalMs: number;
	rpcHealthIntervalMs: number;
	reorgMonitorMs: number;
	retentionAuditMs: number;
};

const operationalSettingsSchema = z.object({
	immediateReleaseMode: z.boolean(),
	fixedExpiryMs: z.number().int().min(60_000).max(604_800_000),
	defaultExpiryMs: z.number().int().min(60_000).max(86_400_000),
	maxExpiryMs: z.number().int().min(300_000).max(604_800_000),
	latePaymentPolicy: z.enum(["accept", "review", "reject"]),
	webhookMaxAttempts: z.number().int().min(1).max(20),
	webhookTimeoutMs: z.number().int().min(1_000).max(30_000),
	webhookDnsFailurePolicy: z.enum(["reject", "deliver"]),
	paymentScanBatchSize: z.number().int().min(1).max(100),
	paymentScanIntervalMs: z.number().int().min(15_000).max(3_600_000),
	webhookRecoveryIntervalMs: z.number().int().min(60_000).max(3_600_000),
	rpcHealthIntervalMs: z.number().int().min(60_000).max(3_600_000),
	reorgMonitorMs: z.number().int().min(3_600_000).max(604_800_000),
	retentionAuditMs: z.number().int().min(2_592_000_000).max(315_360_000_000),
});
const defaults: OperationalSettings = {
	immediateReleaseMode: false,
	fixedExpiryMs: 900_000,
	defaultExpiryMs: 900_000,
	maxExpiryMs: 86_400_000,
	latePaymentPolicy: "review",
	webhookMaxAttempts: 8,
	webhookTimeoutMs: 10_000,
	webhookDnsFailurePolicy: "reject",
	paymentScanBatchSize: 100,
	paymentScanIntervalMs: 60_000,
	webhookRecoveryIntervalMs: 15 * 60_000,
	rpcHealthIntervalMs: 15 * 60_000,
	reorgMonitorMs: 86_400_000,
	retentionAuditMs: 31_536_000_000,
};

const keys = {
	"orders.immediate_release_mode": "immediateReleaseMode",
	"orders.fixed_expiry_ms": "fixedExpiryMs",
	"orders.default_expiry_ms": "defaultExpiryMs",
	"orders.max_expiry_ms": "maxExpiryMs",
	"payments.late_payment_policy": "latePaymentPolicy",
	"webhooks.max_attempts": "webhookMaxAttempts",
	"webhooks.timeout_ms": "webhookTimeoutMs",
	"webhooks.dns_failure_policy": "webhookDnsFailurePolicy",
	"payments.scan_batch_size": "paymentScanBatchSize",
	"payments.scan_interval_ms": "paymentScanIntervalMs",
	"payments.webhook_recovery_interval_ms": "webhookRecoveryIntervalMs",
	"payments.rpc_health_interval_ms": "rpcHealthIntervalMs",
	"payments.reorg_monitor_ms": "reorgMonitorMs",
	"retention.audit_ms": "retentionAuditMs",
} as const;

export async function loadOperationalSettings(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${Object.keys(keys)
				.map(() => "?")
				.join(",")})`,
		)
		.bind(...Object.keys(keys))
		.all<{ key: keyof typeof keys; value: string }>();
	let result: OperationalSettings = { ...defaults };
	for (const row of rows.results) {
		const field = keys[row.key];
		if (!field) continue;
		try {
			const value: unknown = JSON.parse(row.value);
			const parsed = operationalSettingsSchema.safeParse({
				...result,
				[field]: value,
			});
			if (parsed.success) result = parsed.data;
		} catch {
			// Invalid rows fall back to the validated defaults.
		}
	}
	if (result.defaultExpiryMs > result.maxExpiryMs) {
		result = {
			...result,
			defaultExpiryMs: defaults.defaultExpiryMs,
			maxExpiryMs: defaults.maxExpiryMs,
		};
	}
	return result;
}
