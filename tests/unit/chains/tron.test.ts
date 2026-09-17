import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TronAdapter } from "#/integrations/chains/tron";
import nowBlockFixture from "../../fixtures/chains/tron-now-block.json";
import tokenInfoFixture from "../../fixtures/chains/tron-token-info.json";
import transactionInfoFixture from "../../fixtures/chains/tron-transaction-info.json";
import eventFixture from "../../fixtures/chains/tron-transfer-event.json";
import { MockTronAdapter } from "../../fixtures/mock-tron-adapter";

const address = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const zeroAddress = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
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
	it("normalizes confirmed TRC20 transfers from TronGrid", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(nowBlock(100)))
				.mockResolvedValueOnce(
					jsonResponse({
						success: true,
						data: [
							{
								transaction_id: "trc20-hash",
								block_timestamp: 1_700_000_000_000,
								block_number: 90,
								from: zeroAddress,
								to: address,
								value: "1250000",
								type: "Transfer",
								token_info: { symbol: "USDT" },
							},
						],
					}),
				)
				.mockResolvedValueOnce(jsonResponse(block(90, "block-90"))),
		);
		const [transaction] = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).findTransactions({ address, assetCode: "USDT", sinceBlock: 80n });
		expect(transaction).toMatchObject({
			hash: "trc20-hash",
			to: address,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockNumber: 90n,
			confirmations: 11,
			success: true,
		});
	});
	it("preserves event identity and converts TVM event addresses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(transactionInfoFixture))
				.mockResolvedValueOnce(jsonResponse(nowBlockFixture))
				.mockResolvedValueOnce(jsonResponse(block(90, "transaction-block")))
				.mockResolvedValueOnce(jsonResponse(eventFixture))
				.mockResolvedValueOnce(jsonResponse(tokenInfoFixture)),
		);
		const transaction = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).getTransaction("trc20-event-hash");
		expect(transaction).toMatchObject({
			hash: "trc20-event-hash",
			eventIndex: 3,
			from: zeroAddress,
			to: zeroAddress,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockHash: "transaction-block",
			confirmations: 11,
		});
	});
	it("selects the requested TRC20 event from a multi-event transaction", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({ id: "multi-event", blockNumber: 90 }),
				)
				.mockResolvedValueOnce(jsonResponse(nowBlock(100)))
				.mockResolvedValueOnce(jsonResponse(block(90, "block-90")))
				.mockResolvedValueOnce(
					jsonResponse({
						data: [
							tronEvent(1, address, "1"),
							tronEvent(4, zeroAddress, "2500000"),
						],
					}),
				)
				.mockResolvedValueOnce(jsonResponse({ data: [{ symbol: "USDT" }] })),
		);
		await expect(
			new TronAdapter({ apiUrl: "https://api.trongrid.io" }).getTransaction(
				"multi-event",
				{ address: zeroAddress, assetCode: "USDT", eventIndex: 4 },
			),
		).resolves.toMatchObject({
			to: zeroAddress,
			eventIndex: 4,
			amountUnits: 2_500_000n,
			blockHash: "block-90",
		});
	});
	it("follows TronGrid fingerprints without dropping later pages", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(nowBlock(100)))
			.mockResolvedValueOnce(
				jsonResponse({
					data: [trc20("page-1", 99, "1")],
					meta: { fingerprint: "next page" },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({ data: [trc20("page-2", 98, "2")], meta: {} }),
			)
			.mockResolvedValueOnce(jsonResponse(block(99, "block-99")))
			.mockResolvedValueOnce(jsonResponse(block(98, "block-98")));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).findTransactions({ address, assetCode: "USDT" });
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"page-1",
			"page-2",
		]);
		expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
			"fingerprint=next%20page",
		);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "tron",
				operation: "find_transactions",
				requestCount: 5,
				paginationRequestCount: 2,
			}),
		);
	});
	it("rejects repeated TronGrid cursors instead of looping forever", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(nowBlock(100)))
				.mockResolvedValueOnce(
					jsonResponse({ data: [], meta: { fingerprint: "same" } }),
				)
				.mockResolvedValueOnce(
					jsonResponse({ data: [], meta: { fingerprint: "same" } }),
				),
		);
		await expect(
			new TronAdapter({ apiUrl: "https://api.trongrid.io" }).findTransactions({
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
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(nowBlock(100)))
				.mockResolvedValueOnce(
					jsonResponse({ data: [trc20("stable", 90, "1")] }),
				)
				.mockResolvedValueOnce(jsonResponse(block(90, "canonical-90")))
				.mockResolvedValueOnce(jsonResponse(nowBlock(101)))
				.mockResolvedValueOnce(
					jsonResponse({ data: [trc20("stable", 90, "1")] }),
				)
				.mockResolvedValueOnce(jsonResponse(block(90, "canonical-90"))),
		);
		const adapter = new TronAdapter({ apiUrl: "https://api.trongrid.io" });
		const [first] = await adapter.findTransactions({
			address,
			assetCode: "USDT",
		});
		const [second] = await adapter.findTransactions({
			address,
			assetCode: "USDT",
		});
		expect(first?.blockHash).toBe("canonical-90");
		expect(second?.blockHash).toBe("canonical-90");
		expect(second?.confirmations).toBe(12);
	});
	it("bounds block lookups without changing transaction order", async () => {
		let active = 0;
		let maximum = 0;
		const rows = Array.from({ length: 8 }, (_, index) =>
			trc20(`tx-${index}`, 90 + index, String(index + 1)),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/wallet/getnowblock"))
					return jsonResponse(nowBlock(110));
				if (url.includes("/transactions/trc20?"))
					return jsonResponse({ data: rows });
				if (url.endsWith("/wallet/getblockbynum")) {
					active += 1;
					maximum = Math.max(maximum, active);
					await new Promise((resolve) => setTimeout(resolve, 1));
					const request = JSON.parse(String(init?.body)) as { num: number };
					active -= 1;
					return jsonResponse(block(request.num, `block-${request.num}`));
				}
				throw new Error(`Unexpected TRON request ${url}`);
			}),
		);
		const transactions = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
			maxConcurrentRequests: 3,
		}).findTransactions({ address, assetCode: "USDT" });
		expect(maximum).toBe(3);
		expect(transactions.map((transaction) => transaction.hash)).toEqual(
			rows.map((row) => row.transaction_id),
		);
	});
	it("rejects transaction rows above the configured scan limit", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(nowBlock(110)))
			.mockResolvedValueOnce(
				jsonResponse({
					data: [trc20("first", 100, "1"), trc20("second", 99, "2")],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new TronAdapter({
				apiUrl: "https://api.trongrid.io",
				maxScanTransactions: 1,
			}).findTransactions({ address, assetCode: "USDT" }),
		).rejects.toThrow("configured row limit");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("filters old rows before requesting canonical block hashes", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(nowBlock(110)))
			.mockResolvedValueOnce(
				jsonResponse({
					data: [trc20("old", 90, "1"), trc20("current", 100, "2")],
				}),
			)
			.mockResolvedValueOnce(jsonResponse(block(100, "block-100")));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
		}).findTransactions({ address, assetCode: "USDT", sinceBlock: 100n });
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"current",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const blockRequest = JSON.parse(
			String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
		) as { num: number };
		expect(blockRequest.num).toBe(100);
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
				apiUrl: "https://api.trongrid.io",
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
		const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
		const requested: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requested.push(url);
				if (url.endsWith("/wallet/getnowblock"))
					return jsonResponse(nowBlock(110));
				if (url.includes("/transactions/trc20?")) {
					const { block_number: _new, ...fresh } = trc20("new", 0, "5");
					const { block_number: _old, ...stale } = trc20("old", 0, "6");
					const { block_number: _fake, ...fake } = trc20("fake", 0, "7");
					return jsonResponse({
						data: [
							{ ...fresh, token_info: { symbol: "USDT", address: usdt } },
							{
								...fake,
								token_info: { symbol: "USDT", address: zeroAddress },
							},
							{ ...stale, token_info: { symbol: "USDT", address: usdt } },
						],
					});
				}
				if (url.endsWith("/wallet/gettransactioninfobyid")) {
					const { value } = JSON.parse(String(init?.body)) as {
						value: string;
					};
					return jsonResponse({
						id: value,
						blockNumber: value === "new" ? 105 : 80,
						receipt: { result: "SUCCESS" },
					});
				}
				if (url.endsWith("/wallet/getblockbynum")) {
					const request = JSON.parse(String(init?.body)) as { num: number };
					return jsonResponse(block(request.num, `block-${request.num}`));
				}
				throw new Error(`Unexpected TRON request ${url}`);
			}),
		);
		const transactions = await new TronAdapter({
			apiUrl: "https://api.trongrid.io",
			maxConcurrentRequests: 1,
			tokens: { USDT: { contract: usdt, decimals: 6 } },
		}).findTransactions({ address, assetCode: "USDT", sinceBlock: 100n });
		expect(transactions).toEqual([
			expect.objectContaining({
				hash: "new",
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

function tronEvent(eventIndex: number, to: string, value: string) {
	return {
		contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		block_timestamp: 1_700_000_000_000,
		event_index: eventIndex,
		result: { from: address, to, value },
	};
}

function jsonResponse(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
