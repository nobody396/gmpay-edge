import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import { operationDeadline, operationSignal } from "./operation-deadline";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
} from "./types";

const configSchema = z.object({
	apiUrl: z.url().default("https://api.trongrid.io"),
	apiKey: z.string().min(1).optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(500).default(50),
	maxConcurrentRequests: z.number().int().min(1).max(10).default(3),
	maxScanTransactions: z.number().int().min(1).max(10_000).default(1000),
	// Only used when apiUrl is a node's `/jsonrpc` endpoint: ~1 hour of blocks.
	blockLookback: z.number().int().min(1).max(20_000).default(1200),
	logBlockRange: z.number().int().min(1).max(20_000).default(1000),
	tokens: z
		.record(
			z.string(),
			z.object({
				contract: z.string().min(1),
				decimals: z.number().int().optional(),
			}),
		)
		.default({}),
});
export type TronConfig = z.infer<typeof configSchema>;

const envelopeSchema = z.object({
	success: z.boolean().optional(),
	data: z.array(z.unknown()).default([]),
	meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
});
// Account rows only locate candidate transactions; amounts and identity come
// from the receipt.
const trc20TransferSchema = z.object({
	transaction_id: z.string(),
	// TronGrid stopped returning block_number on account TRC20 rows.
	block_number: z.number().optional(),
	to: z.string(),
	token_info: z.object({ address: z.string().optional() }),
});
const transactionInfoSchema = z.looseObject({
	id: z.string().optional(),
	blockNumber: z.number().optional(),
	blockTimeStamp: z.number().optional(),
	receipt: z.looseObject({ result: z.string().optional() }).optional(),
	log: z
		.array(
			z.looseObject({
				address: z.string().optional(),
				topics: z.array(z.string()).default([]),
				data: z.string().optional(),
			}),
		)
		.default([]),
});
const transferTopic =
	"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const logSchema = z.object({
	blockNumber: z.string(),
	transactionHash: z.string(),
	removed: z.boolean().optional(),
});
const atomicAmountSchema = z.union([
	z.string().regex(/^\d+$/),
	z
		.number()
		.int()
		.nonnegative()
		.refine(Number.isSafeInteger, "Atomic amount number is not safe"),
]);
const trxTransactionSchema = z.object({
	txID: z.string(),
	blockNumber: z.number(),
	block_timestamp: z.number(),
	ret: z.array(z.object({ contractRet: z.string() })).default([]),
	raw_data: z.object({
		contract: z.array(
			z.object({
				type: z.string(),
				parameter: z.object({
					value: z.object({
						amount: atomicAmountSchema,
						owner_address: z.string(),
						to_address: z.string(),
					}),
				}),
			}),
		),
	}),
});
const nowBlockSchema = z.object({
	blockID: z.string(),
	block_header: z.object({
		raw_data: z.object({
			number: z.number(),
			timestamp: z.number().optional(),
		}),
	}),
});

export class TronAdapter implements PaymentAdapter<TronConfig> {
	readonly id = "tron";
	readonly network = "tron" as const;
	readonly configSchema = configSchema;
	readonly config: TronConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown): TronConfig {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: {
		address: string;
		expiresAt: Date;
	}): Promise<PaymentTarget> {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TRON address");
		return { address: input.address, expiresAt: input.expiresAt };
	}
	validateAddress(address: string): boolean {
		return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
	}
	validatePayment(
		tx: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	): boolean {
		return (
			tx.success &&
			tx.canonical !== false &&
			tx.network === "tron" &&
			tx.to === target.address &&
			tx.assetCode === assetCode
		);
	}
	async getTransaction(
		hash: string,
		lookup?: TransactionLookup,
	): Promise<NormalizedTransaction | null> {
		return observeProviderOperation(
			{
				adapter: "tron",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.getTransactionObserved(hash, lookup, counters),
		);
	}
	private async getTransactionObserved(
		submittedHash: string,
		lookup: TransactionLookup | undefined,
		counters: ProviderOperationCounters,
	): Promise<NormalizedTransaction | null> {
		const hash = canonicalTronHash(submittedHash);
		if (!hash) return null;
		const wantsNative = lookup?.assetCode?.toUpperCase() === "TRX";
		const contract = this.tokenContract(lookup?.assetCode);
		// A token transfer is only trusted from the configured contract's receipt
		// log; symbols and indexer event rows are free for anyone to imitate.
		if (!wantsNative && (!contract || !lookup?.assetCode)) return null;
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const [info, current] = await Promise.all([
			this.request<unknown>(
				"/wallet/gettransactioninfobyid",
				{
					method: "POST",
					body: JSON.stringify({ value: hash }),
				},
				deadlineAt,
				counters,
			),
			this.currentBlock(deadlineAt, counters),
		]);
		const parsedInfo = transactionInfoSchema.parse(info);
		if (!parsedInfo.id || parsedInfo.blockNumber == null) return null;
		if (canonicalTronHash(parsedInfo.id) !== hash)
			throw new Error("TRON API returned the wrong transaction");
		if (!wantsNative && contract && lookup?.assetCode) {
			const transfer = receiptTransfers(parsedInfo, contract).find(
				(candidate) =>
					(lookup.address == null || candidate.to === lookup.address) &&
					(lookup.eventIndex == null ||
						candidate.eventIndex === lookup.eventIndex),
			);
			if (!transfer) return null;
			return this.normalizeReceiptTransfer(
				hash,
				parsedInfo,
				transfer,
				lookup.assetCode,
				current,
				await this.blockHash(parsedInfo.blockNumber, deadlineAt, counters),
			);
		}
		const [blockHash, rawTransaction] = await Promise.all([
			this.blockHash(parsedInfo.blockNumber, deadlineAt, counters),
			this.request(
				"/wallet/gettransactionbyid",
				{
					method: "POST",
					body: JSON.stringify({ value: hash }),
				},
				deadlineAt,
				counters,
			),
		]);
		return this.normalizeTrx(
			trxTransactionSchema.parse(rawTransaction),
			current,
			blockHash,
			lookup,
		);
	}
	async findTransactions(input: {
		address: string;
		assetCode: string;
		sinceBlock?: bigint;
	}): Promise<NormalizedTransaction[]> {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TRON address");
		return observeProviderOperation(
			{
				adapter: "tron",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.findTransactionsObserved(input, counters),
		);
	}
	private async findTransactionsObserved(
		input: {
			address: string;
			assetCode: string;
			sinceBlock?: bigint;
		},
		counters: ProviderOperationCounters,
	): Promise<NormalizedTransaction[]> {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const current = await this.currentBlock(deadlineAt, counters);
		const native = input.assetCode.toUpperCase() === "TRX";
		const contract = this.tokenContract(input.assetCode);
		if (!native && !contract) throw new TronConfigurationError();
		const blockHashes = new Map<number, Promise<string>>();
		const blockHash = (blockNumber: number) => {
			let pending = blockHashes.get(blockNumber);
			if (!pending) {
				pending = this.blockHash(blockNumber, deadlineAt, counters);
				blockHashes.set(blockNumber, pending);
			}
			return pending;
		};
		if (contract && !native) {
			const hashes = this.logScan
				? await this.findTransferLogHashes(
						input,
						contract,
						current,
						deadlineAt,
						counters,
					)
				: await this.findIndexedTransferHashes(
						input,
						contract,
						deadlineAt,
						counters,
					);
			return this.receiptTransactions(
				hashes,
				input,
				contract,
				current,
				blockHash,
				deadlineAt,
				counters,
			);
		}
		const rows = await this.accountTransactions(
			`/v1/accounts/${input.address}/transactions?only_to=true&limit=200&order_by=block_timestamp,desc`,
			deadlineAt,
			counters,
		);
		const transactions = await mapConcurrently(
			rows
				.map((row) => trxTransactionSchema.parse(row))
				.filter(
					(row) =>
						input.sinceBlock == null ||
						BigInt(row.blockNumber) >= input.sinceBlock,
				),
			this.config.maxConcurrentRequests,
			async (row) =>
				this.normalizeTrx(row, current, await blockHash(row.blockNumber)),
		);
		return transactions.filter(
			(transaction) =>
				transaction.to === input.address &&
				(input.sinceBlock == null ||
					transaction.blockNumber >= input.sinceBlock),
		);
	}
	/**
	 * TronGrid account rows only locate candidate transactions. Rows that carry a
	 * block below the scan cursor are skipped before any receipt lookup.
	 */
	private async findIndexedTransferHashes(
		input: { address: string; sinceBlock?: bigint },
		contract: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const rows = await this.accountTransactions(
			`/v1/accounts/${input.address}/transactions/trc20?only_to=true&limit=200&order_by=block_timestamp,desc&contract_address=${encodeURIComponent(contract)}`,
			deadlineAt,
			counters,
		);
		const hashes = new Set<string>();
		for (const row of rows.map((value) => trc20TransferSchema.parse(value))) {
			const hash = canonicalTronHash(row.transaction_id);
			if (
				!hash ||
				row.to !== input.address ||
				(row.token_info.address != null && row.token_info.address !== contract)
			)
				continue;
			if (
				input.sinceBlock != null &&
				row.block_number != null &&
				BigInt(row.block_number) < input.sinceBlock
			)
				continue;
			hashes.add(hash);
		}
		return [...hashes];
	}
	/**
	 * Both scan transports and submitted hashes derive a transfer's identity from
	 * the same receipt: its event index is the log position inside the transaction.
	 * Hashes arrive newest first, so lookup stops after the batch that reaches
	 * below the scan cursor instead of reading the whole address history.
	 */
	private async receiptTransactions(
		hashes: readonly string[],
		input: { address: string; assetCode: string; sinceBlock?: bigint },
		contract: string,
		current: { number: number },
		blockHash: (blockNumber: number) => Promise<string>,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	): Promise<NormalizedTransaction[]> {
		const transactions: NormalizedTransaction[] = [];
		const size = this.config.maxConcurrentRequests;
		for (let index = 0; index < hashes.length; index += size) {
			const batch = await Promise.all(
				hashes.slice(index, index + size).map(async (hash) => {
					const info = transactionInfoSchema.parse(
						await this.request(
							"/wallet/gettransactioninfobyid",
							{ method: "POST", body: JSON.stringify({ value: hash }) },
							deadlineAt,
							counters,
						),
					);
					const blockNumber = info.blockNumber;
					// Not yet in a block: the next scan picks it up.
					if (blockNumber == null) return null;
					if (canonicalTronHash(info.id ?? "") !== hash)
						throw new Error("TRON API returned the wrong transaction");
					if (
						input.sinceBlock != null &&
						BigInt(blockNumber) < input.sinceBlock
					)
						return "below_cursor" as const;
					const transfers = receiptTransfers(info, contract).filter(
						(transfer) => transfer.to === input.address,
					);
					if (!transfers.length) return null;
					const resolvedHash = await blockHash(blockNumber);
					return transfers.map((transfer) =>
						this.normalizeReceiptTransfer(
							hash,
							info,
							transfer,
							input.assetCode,
							current,
							resolvedHash,
						),
					);
				}),
			);
			for (const result of batch)
				if (Array.isArray(result)) transactions.push(...result);
			if (batch.includes("below_cursor")) break;
		}
		return transactions;
	}
	// A node `/jsonrpc` endpoint needs no TronGrid key: transfers come from
	// eth_getLogs and receipts from the node HTTP API next to it.
	private get logScan() {
		return /\/jsonrpc\/?$/.test(this.config.apiUrl);
	}
	private get nodeUrl() {
		return this.config.apiUrl.replace(/\/$/, "").replace(/\/jsonrpc$/, "");
	}
	private async findTransferLogHashes(
		input: { address: string; sinceBlock?: bigint },
		contract: string,
		current: { number: number },
		deadlineAt: number,
		counters: ProviderOperationCounters,
	): Promise<string[]> {
		const latest = current.number;
		if (input.sinceBlock != null && input.sinceBlock > BigInt(latest))
			return [];
		const earliest = Math.max(0, latest - this.config.blockLookback + 1);
		const from =
			input.sinceBlock == null
				? earliest
				: Math.max(earliest, Number(input.sinceBlock));
		const hashes = new Set<string>();
		let rangeStart = from;
		let blockRange = this.config.logBlockRange;
		while (rangeStart <= latest) {
			counters.page();
			const rangeEnd = Math.min(latest, rangeStart + blockRange - 1);
			let raw: unknown;
			try {
				raw = await this.jsonRpc(
					"eth_getLogs",
					[
						{
							address: `0x${tronBase58ToHex(contract).slice(2)}`,
							fromBlock: `0x${rangeStart.toString(16)}`,
							toBlock: `0x${rangeEnd.toString(16)}`,
							topics: [
								`0x${transferTopic}`,
								null,
								`0x${tronBase58ToHex(input.address).slice(2).padStart(64, "0")}`,
							],
						},
					],
					deadlineAt,
					counters,
				);
			} catch (error) {
				if (blockRange > 1 && error instanceof TronRpcError) {
					blockRange = Math.max(1, Math.floor(blockRange / 2));
					continue;
				}
				throw error;
			}
			for (const row of z.array(logSchema).parse(raw)) {
				if (row.removed) continue;
				const hash = canonicalTronHash(row.transactionHash);
				if (hash) hashes.add(hash);
			}
			if (hashes.size > this.config.maxScanTransactions)
				throw new Error("TRON scan exceeded the configured row limit");
			rangeStart = rangeEnd + 1;
		}
		return [...hashes];
	}
	private normalizeReceiptTransfer(
		hash: string,
		info: z.infer<typeof transactionInfoSchema>,
		transfer: ReceiptTransfer,
		assetCode: string,
		current: { number: number },
		blockHash: string,
	): NormalizedTransaction {
		const blockNumber = info.blockNumber ?? 0;
		return {
			network: "tron",
			hash,
			eventIndex: transfer.eventIndex,
			from: transfer.from,
			to: transfer.to,
			assetCode: assetCode.toUpperCase(),
			amountUnits: transfer.amountUnits,
			blockNumber: BigInt(blockNumber),
			blockHash,
			confirmations: confirmations(current.number, blockNumber),
			timestamp: new Date(info.blockTimeStamp ?? 0),
			success:
				info.receipt?.result == null || info.receipt.result === "SUCCESS",
			canonical: true,
		};
	}
	private async jsonRpc(
		method: string,
		params: unknown[],
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		counters.request();
		const response = await fetch(this.config.apiUrl, {
			method: "POST",
			signal: operationSignal(deadlineAt, "TRON operation"),
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		if (!response.ok) throw new TronHttpError(response.status);
		const body = z
			.object({
				result: z.unknown().optional(),
				error: z.object({ message: z.string().optional() }).optional(),
			})
			.parse(await response.json());
		if (body.error) throw new TronRpcError();
		return body.result;
	}
	private tokenContract(assetCode: string | undefined) {
		if (!assetCode) return undefined;
		const upper = assetCode.toUpperCase();
		const entry = Object.entries(this.config.tokens).find(
			([code]) => code.toUpperCase() === upper,
		);
		return entry?.[1].contract;
	}
	private async accountTransactions(
		path: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const rows: unknown[] = [];
		const seen = new Set<string>();
		let fingerprint: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters.page();
			const separator = path.includes("?") ? "&" : "?";
			const envelope = envelopeSchema.parse(
				await this.request(
					fingerprint
						? `${path}${separator}fingerprint=${encodeURIComponent(fingerprint)}`
						: path,
					undefined,
					deadlineAt,
					counters,
				),
			);
			if (rows.length + envelope.data.length > this.config.maxScanTransactions)
				throw new Error(
					"TRON transaction scan exceeded the configured row limit",
				);
			rows.push(...envelope.data);
			const next = envelope.meta?.fingerprint;
			if (!next) return rows;
			if (rows.length >= this.config.maxScanTransactions)
				throw new Error(
					"TRON transaction scan exceeded the configured row limit",
				);
			if (seen.has(next))
				throw new Error("TRON API repeated its pagination cursor");
			seen.add(next);
			fingerprint = next;
		}
		throw new Error(
			"TRON transaction pagination exceeded the configured limit",
		);
	}
	async getConfirmations(transaction: NormalizedTransaction): Promise<number> {
		return observeProviderOperation(
			{
				adapter: "tron",
				operation: "get_confirmations",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const current = await this.currentBlock(undefined, counters);
				return confirmations(current.number, Number(transaction.blockNumber));
			},
		);
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "tron",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.currentBlock(undefined, counters),
			);
			return {
				healthy: true,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				detail: `TRON health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof TronHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 404) return "not_found";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (error instanceof z.ZodError || error instanceof TronRpcError)
			return "invalid_response";
		if (error instanceof TronConfigurationError) return "configuration";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}
	isRetryable(kind: AdapterErrorKind): boolean {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	private async currentBlock(
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const block = nowBlockSchema.parse(
			await this.request(
				"/wallet/getnowblock",
				undefined,
				deadlineAt,
				counters,
			),
		);
		return { number: block.block_header.raw_data.number };
	}
	private async blockHash(
		blockNumber: number,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const block = nowBlockSchema.parse(
			await this.request(
				"/wallet/getblockbynum",
				{
					method: "POST",
					body: JSON.stringify({ num: blockNumber }),
				},
				deadlineAt,
				counters,
			),
		);
		if (block.block_header.raw_data.number !== blockNumber)
			throw new Error("TRON API returned the wrong block");
		return block.blockID;
	}
	private async request<T>(
		path: string,
		init?: RequestInit,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<T> {
		counters?.request();
		const response = await fetch(`${this.nodeUrl}${path}`, {
			...init,
			signal: operationSignal(deadlineAt, "TRON operation"),
			headers: {
				"content-type": "application/json",
				...(this.config.apiKey
					? { "TRON-PRO-API-KEY": this.config.apiKey }
					: {}),
				...init?.headers,
			},
		});
		if (!response.ok) throw new TronHttpError(response.status);
		return (await response.json()) as T;
	}
	private normalizeTrx(
		row: z.infer<typeof trxTransactionSchema>,
		current: { number: number },
		blockHash: string,
		lookup?: TransactionLookup,
	): NormalizedTransaction {
		const transfer = row.raw_data.contract.find(
			(contract) =>
				contract.type === "TransferContract" &&
				(lookup?.address == null ||
					tronHexToBase58(contract.parameter.value.to_address) ===
						lookup.address),
		);
		if (!transfer) throw new Error("Unsupported TRON transaction contract");
		return {
			network: "tron",
			hash: row.txID.toLowerCase(),
			eventIndex: 0,
			from: tronHexToBase58(transfer.parameter.value.owner_address),
			to: tronHexToBase58(transfer.parameter.value.to_address),
			assetCode: "TRX",
			amountUnits: BigInt(transfer.parameter.value.amount),
			blockNumber: BigInt(row.blockNumber),
			blockHash,
			confirmations: confirmations(current.number, row.blockNumber),
			timestamp: new Date(row.block_timestamp),
			success: row.ret.every((result) => result.contractRet === "SUCCESS"),
			canonical: true,
		};
	}
}

async function mapConcurrently<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
) {
	const results = new Array<R>(items.length);
	const entries = items.map((item, index) => ({ index, item }));
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
			while (nextIndex < entries.length) {
				const entry = entries[nextIndex];
				nextIndex += 1;
				if (!entry) break;
				results[entry.index] = await map(entry.item);
			}
		}),
	);
	return results;
}

class TronRpcError extends Error {
	constructor() {
		super("TRON JSON-RPC returned an error");
	}
}
class TronConfigurationError extends Error {
	constructor() {
		super("TRON log scanning needs a configured token contract");
	}
}
type ReceiptTransfer = {
	eventIndex: number;
	from: string;
	to: string;
	amountUnits: bigint;
};
// Event index is the log position inside the transaction, matching the
// TronGrid event_index already stored for earlier payments.
function receiptTransfers(
	info: z.infer<typeof transactionInfoSchema>,
	contract: string,
): ReceiptTransfer[] {
	const contractHex = tronBase58ToHex(contract).slice(2);
	const transfers: ReceiptTransfer[] = [];
	info.log.forEach((log, eventIndex) => {
		const [topic, from, to] = log.topics.map((value) =>
			value.replace(/^0x/i, "").toLowerCase(),
		);
		if (
			log.address
				?.replace(/^0x/i, "")
				.replace(/^41(?=[0-9a-f]{40}$)/i, "")
				.toLowerCase() !== contractHex ||
			topic !== transferTopic ||
			!from ||
			!to ||
			!log.data
		)
			return;
		transfers.push({
			eventIndex,
			from: normalizeTronEventAddress(from),
			to: normalizeTronEventAddress(to),
			amountUnits: BigInt(`0x${log.data.replace(/^0x/i, "") || "0"}`),
		});
	});
	return transfers;
}
class TronHttpError extends Error {
	constructor(readonly status: number) {
		super(`TRON API returned HTTP ${status}`);
	}
}
/** TRON transaction IDs are 32-byte hex; providers and payers vary case and `0x`. */
function canonicalTronHash(value: string) {
	const hash = value.trim().replace(/^0x/i, "").toLowerCase();
	return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}
function confirmations(current: number, block: number) {
	return Math.max(0, current - block + 1);
}
function tronHexToBase58(value: string) {
	const bytes = Uint8Array.from(
		value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
	);
	if (bytes.length !== 21 || bytes[0] !== 0x41)
		throw new Error("Invalid TRON hex address");
	const checksum = sha256(sha256(bytes)).slice(0, 4);
	return base58Encode(Uint8Array.from([...bytes, ...checksum]));
}
function normalizeTronEventAddress(value: string) {
	if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return value;
	const hex = value.replace(/^0x/i, "");
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 40)
		throw new Error("Invalid TRON event address");
	return tronHexToBase58(`41${hex.slice(-40)}`);
}
function tronBase58ToHex(address: string) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let value = 0n;
	for (const character of address) {
		const digit = alphabet.indexOf(character);
		if (digit < 0) throw new Error("Invalid TRON address");
		value = value * 58n + BigInt(digit);
	}
	// 21 payload bytes + 4 checksum bytes; the payload keeps the 0x41 prefix.
	const hex = value.toString(16).padStart(50, "0");
	if (hex.length !== 50 || !hex.startsWith("41"))
		throw new Error("Invalid TRON address");
	return hex.slice(0, 42).toLowerCase();
}
function base58Encode(bytes: Uint8Array) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let value = BigInt(
		`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
	);
	let output = "";
	while (value > 0n) {
		output = alphabet[Number(value % 58n)] + output;
		value /= 58n;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		output = `1${output}`;
	}
	return output;
}
