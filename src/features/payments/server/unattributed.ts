import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";

/** Persist evidence before acknowledging a scan or advancing its cursor. No money moves. */
export async function retainUnattributedPayment(
	db: D1Database,
	transaction: NormalizedTransaction,
	reason: string,
) {
	const now = Date.now();
	const transactionId = paymentTransactionId(transaction);
	const id = `unattributed:${transactionId}`;
	await db.batch([
		db
			.prepare(`INSERT INTO blockchain_transactions
		 (id,network,tx_hash,event_index,from_address,to_address,asset_code,amount_units,
		 block_number,block_hash,confirmations,status,observed_at,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)
		 ON CONFLICT(network,tx_hash,event_index) DO NOTHING`)
			.bind(
				id,
				transaction.network,
				transaction.hash,
				transaction.eventIndex,
				transaction.from,
				transaction.to,
				transaction.assetCode,
				transaction.amountUnits.toString(),
				transaction.blockNumber.toString(),
				transaction.blockHash,
				transaction.confirmations,
				transaction.timestamp.getTime(),
				now,
				now,
			),
		db
			.prepare(`INSERT OR IGNORE INTO audit_logs
		 (id,action,target_type,target_id,after,created_at)
		 VALUES (?,'payment.attribution_review_required','blockchain_transaction',?,?,?)`)
			.bind(
				id,
				transactionId,
				JSON.stringify({
					transactionId,
					reason,
					amountUnits: transaction.amountUnits.toString(),
				}),
				now,
			),
	]);
}
