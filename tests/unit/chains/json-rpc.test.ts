import { afterEach, describe, expect, it, vi } from "vitest";
import {
	JsonRpcRequestError,
	requestJsonRpc,
} from "#/integrations/chains/json-rpc";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

describe("JSON-RPC transports", () => {
	it("uses HTTP JSON-RPC with the configured bearer credential", async () => {
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as { id: string };
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: "0x10",
				});
			});
		await expect(
			requestJsonRpc<string>({
				url: "https://rpc.example",
				method: "eth_blockNumber",
				params: [],
				timeoutMs: 1_000,
				apiKey: "read-only",
			}),
		).resolves.toBe("0x10");
		expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer read-only",
		});
	});

	it("injects an encrypted credential into an RPC endpoint template", async () => {
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json({ jsonrpc: "2.0", id: 1, result: "0x38" }),
			);
		await expect(
			requestJsonRpc<string>({
				url: "https://rpc.example/bsc/__API_KEY__",
				method: "eth_chainId",
				params: [],
				timeoutMs: 1_000,
				apiKey: "read-only/key",
			}),
		).resolves.toBe("0x38");
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://rpc.example/bsc/read-only%2Fkey",
		);
		expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
			"authorization",
		);
	});

	it("performs a request-response exchange over WSS", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		await expect(
			requestJsonRpc<number>({
				url: "wss://rpc.example",
				method: "getSlot",
				params: [],
				timeoutMs: 1_000,
			}),
		).resolves.toBe(42);
	});

	it("rejects a mismatched response ID", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ jsonrpc: "2.0", id: "wrong", result: 1 }),
		);
		await expect(
			requestJsonRpc({
				url: "https://rpc.example",
				method: "test",
				params: [],
				timeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(JsonRpcRequestError);
	});

	it("does not expose provider error messages", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32000, message: "secret upstream diagnostics" },
			}),
		);
		const error = await requestJsonRpc({
			url: "https://rpc.example",
			method: "test",
			params: [],
			timeoutMs: 1_000,
		}).catch((cause) => cause);
		expect(error).toBeInstanceOf(JsonRpcRequestError);
		expect(String(error)).not.toContain("secret upstream diagnostics");
		if (!(error instanceof JsonRpcRequestError)) throw error;
		expect(error.rpcCode).toBe(-32000);
	});

	it("preserves an RPC error code returned with HTTP 400", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{
					error: { code: -32602, message: "sensitive provider detail" },
					id: 1,
				},
				{ status: 400 },
			),
		);
		const error = await requestJsonRpc({
			url: "https://rpc.example",
			method: "eth_getLogs",
			params: [],
			timeoutMs: 1_000,
		}).catch((cause) => cause);
		expect(error).toBeInstanceOf(JsonRpcRequestError);
		expect(String(error)).not.toContain("sensitive provider detail");
		if (!(error instanceof JsonRpcRequestError)) throw error;
		expect(error).toMatchObject({ status: 400, rpcCode: -32602 });
	});

	it("propagates the caller lifetime into an in-flight HTTP request", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		const request = requestJsonRpc({
			url: "https://rpc.example",
			method: "eth_blockNumber",
			params: [],
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		controller.abort(new DOMException("queue task ended", "AbortError"));
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});
});

class FakeWebSocket {
	private readonly listeners = new Map<
		string,
		Array<(event: { data?: string }) => void>
	>();

	constructor(_url: string) {
		queueMicrotask(() => this.emit("open", {}));
	}

	addEventListener(type: string, listener: (event: { data?: string }) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	send(value: string) {
		const request = JSON.parse(value) as { id: string };
		queueMicrotask(() =>
			this.emit("message", {
				data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 42 }),
			}),
		);
	}

	close() {}

	private emit(type: string, event: { data?: string }) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
