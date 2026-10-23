import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TronAdapter } from "#/integrations/chains/tron";
import { MockTronAdapter } from "../../fixtures/mock-tron-adapter";

const address = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const zeroAddress = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const usdtHex = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const transferTopic =
	"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const zeroTopic = "0".repeat(64);
// Topic-encoded `address`.
const targetTopic =
	"000000000000000000000000ea51342dabbb928ae1e576bd39eff8aaf070a8c6";
const unrelatedLog = {
	address: "1111111111111111111111111111111111111111",
	topics: [transferTopic, zeroTopic, targetTopic],
	data: "01",
};
const tronGrid = {
	apiUrl: "https://api.trongrid.io",
	tokens: { USDT: { contract: usdt, decimals: 6 } },
};
describe("TRON adapters", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("validates base58check-shaped addresses", () => {
		const adapter = new TronAdapter({ apiUrl: "https://api.trongrid.io" });
		expect(adapter.validateAddress(address)).toBe(true);
		expect(adapter.validateAddress("0x1234")).toBe(false);
	});
	it("provides deterministic simulated payments", async () => {
		const adapter = new MockTronAdapter();
		adapter.record({
			network: "tron",
			hash: "abc",
			eventIndex: 0,
			from: address,
			to: address,
			assetCode: "USDT",
			amountUnits: 1_000_000n,
			blockNumber: 1n,
			blockHash: "block",
			confirmations: 20,
			timestamp: new Date(),
			success: true,
		});
		expect(await adapter.getTransaction("abc")).toMatchObject({
			assetCode: "USDT",
			amountUnits: 1_000_000n,
		});
	});
	it("normalizes confirmed TRC20 transfers from TronGrid receipts", async () => {
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 100,
				rows: () => [trc20(txHash("trc20"), 90, "1250000")],
			}),
		);
		const [transaction] = await new TronAdapter(tronGrid).findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 80n,
		});
		expect(transaction).toMatchObject({
			hash: txHash("trc20"),
			eventIndex: 0,
			to: address,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockNumber: 90n,
			confirmations: 11,
			success: true,
		});
	});
	it("preserves receipt event identity and converts TVM event addresses", async () => {
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 100,
				receipt: (hash) =>
					receipt(hash, 90, [
						unrelatedLog,
						unrelatedLog,
						unrelatedLog,
						usdtLog(zeroTopic, "1250000"),
					]),
			}),
		);
		const transaction = await new TronAdapter(tronGrid).getTransaction(
			txHash("event"),
			{ assetCode: "USDT" },
		);
		expect(transaction).toMatchObject({
			hash: txHash("event"),
			eventIndex: 3,
			from: zeroAddress,
			to: zeroAddress,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockHash: "block-90",
			confirmations: 11,
		});
	});
	it("selects the requested TRC20 event from a multi-event transaction", async () => {
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 100,
				receipt: (hash) =>
					receipt(hash, 90, [
						unrelatedLog,
						usdtLog(targetTopic, "1"),
						unrelatedLog,
						unrelatedLog,
						usdtLog(zeroTopic, "2500000"),
					]),
			}),
		);
		await expect(
			new TronAdapter(tronGrid).getTransaction(txHash("multi"), {
				address: zeroAddress,
				assetCode: "USDT",
				eventIndex: 4,
			}),
		).resolves.toMatchObject({
			to: zeroAddress,
			eventIndex: 4,
			amountUnits: 2_500_000n,
			blockHash: "block-90",
		});
	});
	it("follows TronGrid fingerprints without dropping later pages", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 100,
				requested,
				rows: () => [
					trc20(txHash("page-1"), 99, "1"),
					trc20(txHash("page-2"), 98, "2"),
				],
				page: (url) =>
					url.includes("fingerprint=next%20page")
						? { data: [trc20(txHash("page-2"), 98, "2")], meta: {} }
						: {
								data: [trc20(txHash("page-1"), 99, "1")],
								meta: { fingerprint: "next page" },
							},
			}),
		);
		const transactions = await new TronAdapter(tronGrid).findTransactions({
			address,
			assetCode: "USDT",
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			txHash("page-1"),
			txHash("page-2"),
		]);
		expect(requested[2]).toContain("fingerprint=next%20page");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "tron",
				operation: "find_transactions",
				requestCount: 7,
				paginationRequestCount: 2,
			}),
		);
	});
	it("rejects repeated TronGrid cursors instead of looping forever", async () => {
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 100,
				page: () => ({ data: [], meta: { fingerprint: "same" } }),
			}),
		);
		await expect(
			new TronAdapter(tronGrid).findTransactions({
				address,
				assetCode: "USDT",
			}),
		).rejects.toThrow("repeated");
	});
	it("normalizes successful native TRX transfers and Base58Check addresses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(nowBlock(25)))
				.mockResolvedValueOnce(
					jsonResponse({
						success: true,
						data: [
							{
								txID: "trx-hash",
								blockNumber: 24,
								block_timestamp: 1_700_000_000_000,
								ret: [{ contractRet: "SUCCESS" }],
								raw_data: {
									contract: [
										{
											type: "TransferContract",
											parameter: {
												value: {
													amount: 2_000_000,
													owner_address:
														"410000000000000000000000000000000000000000",
													to_address:
														"410000000000000000000000000000000000000000",
												},
											},
										},
									],
								},
							},
						],
					}),
				)
				.mockResolvedValueOnce(jsonResponse(block(24, "block-24"))),
		);
		const [transaction] = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).findTransactions({ address: zeroAddress, assetCode: "TRX" });
		expect(transaction).toMatchObject({
			from: zeroAddress,
			to: zeroAddress,
			amountUnits: 2_000_000n,
			blockHash: "block-24",
			confirmations: 2,
		});
	});
	it("rejects unsafe numeric native amounts before BigInt conversion", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(nowBlock(25)))
				.mockResolvedValueOnce(
					jsonResponse({
						success: true,
						data: [
							{
								txID: "unsafe-trx",
								blockNumber: 24,
								block_timestamp: 1_700_000_000_000,
								ret: [{ contractRet: "SUCCESS" }],
								raw_data: {
									contract: [
										{
											type: "TransferContract",
											parameter: {
												value: {
													amount: Number.MAX_SAFE_INTEGER + 1,
													owner_address: `41${"00".repeat(20)}`,
													to_address: `41${"00".repeat(20)}`,
												},
											},
										},
									],
								},
							},
						],
					}),
				),
		);
		await expect(
			new TronAdapter({ apiUrl: "https://api.trongrid.io" }).findTransactions({
				address: zeroAddress,
				assetCode: "TRX",
			}),
		).rejects.toThrow();
	});
	it("keeps canonical block identity stable while the chain head advances", async () => {
		let head = 100;
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => head,
				rows: () => [trc20(txHash("stable"), 90, "1")],
				blockId: (number) => `canonical-${number}`,
			}),
		);
		const adapter = new TronAdapter(tronGrid);
		const [first] = await adapter.findTransactions({
			address,
			assetCode: "USDT",
		});
		head = 101;
		const [second] = await adapter.findTransactions({
			address,
			assetCode: "USDT",
		});
		expect(first?.blockHash).toBe("canonical-90");
		expect(second?.blockHash).toBe("canonical-90");
		expect(second?.confirmations).toBe(12);
	});
	it("bounds receipt and block lookups without changing transaction order", async () => {
		let active = 0;
		let maximum = 0;
		const rows = Array.from({ length: 8 }, (_, index) =>
			trc20(txHash(`tx-${index}`), 90 + index, String(index + 1)),
		);
		const blockNumbers = new Map(
			rows.map((row) => [row.transaction_id, row.block_number]),
		);
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 110,
				rows: () => rows,
				receipt: async (hash) => {
					active += 1;
					maximum = Math.max(maximum, active);
					await new Promise((resolve) => setTimeout(resolve, 1));
					active -= 1;
					return receipt(hash, blockNumbers.get(hash) ?? 0, [
						usdtLog(targetTopic, "1"),
					]);
				},
			}),
		);
		const transactions = await new TronAdapter({
			...tronGrid,
			maxConcurrentRequests: 3,
		}).findTransactions({ address, assetCode: "USDT" });
		expect(maximum).toBe(3);
		expect(transactions.map((transaction) => transaction.hash)).toEqual(
			rows.map((row) => row.transaction_id),
		);
	});
	it("rejects transaction rows above the configured scan limit", async () => {
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 110,
				requested,
				rows: () => [
					trc20(txHash("first"), 100, "1"),
					trc20(txHash("second"), 99, "2"),
				],
			}),
		);
		await expect(
			new TronAdapter({
				...tronGrid,
				maxScanTransactions: 1,
			}).findTransactions({ address, assetCode: "USDT" }),
		).rejects.toThrow("configured row limit");
		expect(requested).toHaveLength(2);
	});
	it("filters old rows before requesting receipts or canonical block hashes", async () => {
		const requested: string[] = [];
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 110,
				requested,
				bodies,
				rows: () => [
					trc20(txHash("current"), 100, "2"),
					trc20(txHash("old"), 90, "1"),
				],
			}),
		);
		const transactions = await new TronAdapter(tronGrid).findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 100n,
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			txHash("current"),
		]);
		expect(requested).toHaveLength(4);
		expect(bodies).toEqual([
			JSON.stringify({ value: txHash("current") }),
			JSON.stringify({ num: 100 }),
		]);
	});
	it("shares one deadline between head and transaction requests", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return jsonResponse(nowBlock(110));
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new TronAdapter({
				...tronGrid,
				timeoutMs: 1000,
			}).findTransactions({ address, assetCode: "USDT" }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("observes confirmation lookups at their provider request owner", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse(nowBlock(100))),
		);
		await expect(
			new TronAdapter({ apiUrl: "https://api.trongrid.io" }).getConfirmations({
				blockNumber: 90n,
			} as never),
		).resolves.toBe(11);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "tron",
				operation: "get_confirmations",
				requestCount: 1,
			}),
		);
	});

	it("resolves missing TronGrid block numbers from receipts and ignores look-alike tokens", async () => {
		const requested: string[] = [];
		const withoutBlock = (hash: string, value: string, token: string) => {
			const { block_number: _block, ...row } = trc20(hash, 0, value);
			return { ...row, token_info: { symbol: "USDT", address: token } };
		};
		vi.stubGlobal(
			"fetch",
			tronGridFetch({
				head: () => 110,
				requested,
				rows: () => [
					withoutBlock(txHash("new"), "5", usdt),
					withoutBlock(txHash("fake"), "7", zeroAddress),
					withoutBlock(txHash("old"), "6", usdt),
				],
				receipt: (hash) =>
					receipt(hash, hash === txHash("new") ? 105 : 80, [
						usdtLog(targetTopic, "5"),
					]),
			}),
		);
		const transactions = await new TronAdapter({
			...tronGrid,
			maxConcurrentRequests: 1,
		}).findTransactions({ address, assetCode: "USDT", sinceBlock: 100n });
		expect(transactions).toEqual([
			expect.objectContaining({
				hash: txHash("new"),
				blockNumber: 105n,
				blockHash: "block-105",
				confirmations: 6,
				success: true,
			}),
		]);
		expect(requested[1]).toContain(`contract_address=${usdt}`);
		expect(
			requested.filter((url) => url.endsWith("/wallet/gettransactioninfobyid")),
		).toHaveLength(2);
	});
	it("scans a node JSON-RPC endpoint without TronGrid account indexes", async () => {
		const hash = txHash("json-rpc");
		const usdtHex = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
		const targetTopic =
			"000000000000000000000000ea51342dabbb928ae1e576bd39eff8aaf070a8c6";
		const fromTopic =
			"0000000000000000000000000000000000000000000000000000000000000000";
		const transfer =
			"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
		const ranges: [number, number][] = [];
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requested.push(url);
				if (url === "https://tron.example/wallet/getnowblock")
					return jsonResponse(nowBlock(110));
				if (url === "https://tron.example/jsonrpc") {
					const body = JSON.parse(String(init?.body)) as {
						params: [{ fromBlock: string; toBlock: string; topics: string[] }];
					};
					const [filter] = body.params;
					const range: [number, number] = [
						Number(filter.fromBlock),
						Number(filter.toBlock),
					];
					// The node rejects wide ranges; the scan must split them.
					if (range[1] - range[0] >= 5)
						return jsonResponse({ error: { message: "range too large" } });
					ranges.push(range);
					expect(filter.topics[2]).toBe(`0x${targetTopic}`);
					return jsonResponse({
						result:
							range[0] <= 105 && 105 <= range[1]
								? [
										{
											blockNumber: "0x69",
											transactionHash: `0x${hash.toUpperCase()}`,
										},
										{ blockNumber: "0x69", transactionHash: `0x${hash}` },
									]
								: [],
					});
				}
				if (url === "https://tron.example/wallet/gettransactioninfobyid") {
					return jsonResponse({
						id: hash,
						blockNumber: 105,
						blockTimeStamp: 1_700_000_000_000,
						receipt: { result: "SUCCESS" },
						log: [
							{
								address: "1111111111111111111111111111111111111111",
								topics: [transfer, fromTopic, targetTopic],
								data: "01",
							},
							{
								address: usdtHex,
								topics: [transfer, fromTopic, targetTopic],
								data: "0f4240",
							},
						],
					});
				}
				if (url === "https://tron.example/wallet/getblockbynum")
					return jsonResponse(block(105, "block-105"));
				throw new Error(`Unexpected TRON request ${url}`);
			}),
		);
		const adapter = new TronAdapter({
			apiUrl: "https://tron.example/jsonrpc",
			blockLookback: 11,
			logBlockRange: 20,
			tokens: { USDT: { contract: usdt, decimals: 6 } },
		});
		const transactions = await adapter.findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 102n,
		});
		expect(transactions).toEqual([
			expect.objectContaining({
				hash,
				eventIndex: 1,
				from: zeroAddress,
				to: address,
				amountUnits: 1_000_000n,
				blockNumber: 105n,
				blockHash: "block-105",
				confirmations: 6,
				timestamp: new Date(1_700_000_000_000),
				success: true,
			}),
		]);
		expect(ranges[0]?.[0]).toBe(102);
		expect(ranges.at(-1)?.[1]).toBe(110);
		expect(
			requested.filter((url) => url.endsWith("/gettransactioninfobyid")),
		).toHaveLength(1);
		expect(requested.some((url) => url.includes("/v1/"))).toBe(false);
		await expect(
			adapter.getTransaction(hash, {
				address,
				assetCode: "USDT",
				eventIndex: 0,
			}),
		).resolves.toBeNull();
		await expect(
			adapter.getTransaction(hash, {
				address,
				assetCode: "USDT",
				eventIndex: 1,
			}),
		).resolves.toMatchObject({ amountUnits: 1_000_000n, eventIndex: 1 });
	});

	it.each([
		"https://api.trongrid.io",
		"https://tron.example/jsonrpc",
	])("gives scans and submitted hashes one receipt-based identity: %s", async (apiUrl) => {
		const hash = "ab".repeat(32);
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requested.push(url);
				if (url.endsWith("/wallet/getnowblock"))
					return jsonResponse(nowBlock(110));
				if (url.includes("/transactions/trc20?"))
					return jsonResponse({
						data: [
							{
								...trc20(hash, 105, "1250000"),
								token_info: { symbol: "USDT", address: usdt },
							},
						],
					});
				if (url.endsWith("/jsonrpc"))
					return jsonResponse({
						result: [{ blockNumber: "0x69", transactionHash: `0x${hash}` }],
					});
				if (url.endsWith("/wallet/gettransactioninfobyid")) {
					const { value } = JSON.parse(String(init?.body)) as {
						value: string;
					};
					expect(value).toBe(hash);
					return jsonResponse(multiTransferReceipt(hash));
				}
				if (url.endsWith("/wallet/getblockbynum"))
					return jsonResponse(block(105, "block-105"));
				throw new Error(`Unexpected TRON request ${url}`);
			}),
		);
		const adapter = new TronAdapter({
			apiUrl,
			tokens: { USDT: { contract: usdt, decimals: 6 } },
		});
		const scanned = await adapter.findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 100n,
		});
		expect(scanned).toEqual([
			expect.objectContaining({
				hash,
				eventIndex: 2,
				to: address,
				amountUnits: 1_250_000n,
			}),
		]);
		for (const submitted of [hash.toUpperCase(), `0x${hash}`, ` ${hash} `])
			await expect(
				adapter.getTransaction(submitted, { address, assetCode: "USDT" }),
			).resolves.toMatchObject({
				hash,
				eventIndex: 2,
				amountUnits: 1_250_000n,
			});
		await expect(
			adapter.getTransaction(hash, {
				address,
				assetCode: "USDT",
				eventIndex: 0,
			}),
		).resolves.toBeNull();
		const before = requested.length;
		await expect(
			adapter.getTransaction("not-a-tron-hash", { address, assetCode: "USDT" }),
		).resolves.toBeNull();
		expect(requested).toHaveLength(before);
		expect(requested.some((url) => url.includes("/events"))).toBe(false);
	});

	it("redacts unexpected provider failures from health details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("provider-secret-and-url")),
		);
		const health = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).healthCheck();
		expect(health).toMatchObject({
			healthy: false,
			detail: "TRON health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});
});

function nowBlock(number: number) {
	return {
		blockID: "block-hash",
		block_header: { raw_data: { number } },
	};
}

function block(number: number, blockID: string) {
	return {
		blockID,
		block_header: { raw_data: { number } },
	};
}

function trc20(hash: string, block: number, value: string) {
	return {
		transaction_id: hash,
		block_timestamp: 1_700_000_000_000,
		block_number: block,
		from: zeroAddress,
		to: address,
		value,
		type: "Transfer",
		token_info: { symbol: "USDT" },
	};
}

function multiTransferReceipt(hash: string) {
	return receipt(hash, 105, [
		// Same recipient, unrelated token contract.
		unrelatedLog,
		// Configured token, different recipient.
		usdtLog(zeroTopic, "2"),
		usdtLog(targetTopic, "1250000"),
	]);
}

function txHash(label: string) {
	return Array.from(label, (character) =>
		character.charCodeAt(0).toString(16).padStart(2, "0"),
	)
		.join("")
		.padEnd(64, "0")
		.slice(0, 64);
}

function usdtLog(toTopic: string, value: string) {
	return {
		address: `41${usdtHex}`,
		topics: [transferTopic, zeroTopic, toTopic],
		data: BigInt(value).toString(16),
	};
}

function receipt(hash: string, blockNumber: number, log: unknown[]) {
	return {
		id: hash,
		blockNumber,
		blockTimeStamp: 1_700_000_000_000,
		receipt: { result: "SUCCESS" },
		log,
	};
}

type Trc20Row = {
	transaction_id: string;
	block_number?: number;
	value: string;
};

/** Routes TronGrid requests by path so tests do not depend on request order. */
function tronGridFetch(options: {
	head: () => number;
	rows?: () => Trc20Row[];
	page?: (url: string) => unknown;
	receipt?: (hash: string) => unknown;
	blockId?: (number: number) => string;
	requested?: string[];
	bodies?: string[];
}) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		options.requested?.push(url);
		if (url.endsWith("/wallet/getnowblock"))
			return jsonResponse(nowBlock(options.head()));
		if (url.includes("/transactions/trc20?"))
			return jsonResponse(
				options.page?.(url) ?? { data: options.rows?.() ?? [] },
			);
		const body = String(init?.body);
		if (url.endsWith("/wallet/gettransactioninfobyid")) {
			options.bodies?.push(body);
			const { value } = JSON.parse(body) as { value: string };
			if (options.receipt) return jsonResponse(await options.receipt(value));
			const row = options
				.rows?.()
				.find((item) => item.transaction_id === value);
			return jsonResponse(
				receipt(value, row?.block_number ?? 0, [
					usdtLog(targetTopic, row?.value ?? "0"),
				]),
			);
		}
		if (url.endsWith("/wallet/getblockbynum")) {
			options.bodies?.push(body);
			const { num } = JSON.parse(body) as { num: number };
			return jsonResponse(block(num, options.blockId?.(num) ?? `block-${num}`));
		}
		throw new Error(`Unexpected TRON request ${url}`);
	});
}

function jsonResponse(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
