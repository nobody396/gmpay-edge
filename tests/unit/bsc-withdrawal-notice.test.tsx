// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutOrder } from "#/features/checkout/checkout-model";
import { BscWithdrawalNotice } from "#/features/checkout/components/bsc-withdrawal-notice";
import { CopyIconButton } from "#/features/checkout/components/checkout-display";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const order: CheckoutOrder = {
	trade_id: "fixture-only",
	amount: "400",
	currency: "CNY",
	network: "bsc",
	token: "USDT",
	actual_amount: "59.8613",
};

describe("BSC withdrawal notice", () => {
	let root: ReturnType<typeof createRoot> | undefined;
	let container: HTMLDivElement | undefined;
	afterEach(async () => {
		await act(async () => root?.unmount());
		container?.remove();
		root = undefined;
		container = undefined;
	});

	async function render(element: React.ReactNode) {
		if (!container) {
			container = document.createElement("div");
			document.body.appendChild(container);
			root = createRoot(container);
		}
		await act(async () => root?.render(element));
	}

	it("copies only the fee-inclusive input while displaying the unchanged receipt target", async () => {
		const onCopy = vi.fn().mockResolvedValue(true);
		await render(<BscWithdrawalNotice onCopyAmount={onCopy} order={order} />);
		expect(container?.textContent).toContain("59.8713 USDT");
		expect(container?.textContent).toContain("59.8613 USDT");
		expect(container?.textContent).toContain("0.01 USDT");
		expect(container?.textContent).toContain("charged separately");
		expect(container?.textContent).toContain("automatic payment confirmation");
		await act(async () => container?.querySelector("button")?.click());
		expect(onCopy).toHaveBeenCalledExactlyOnceWith("59.8713");
		expect(container?.querySelector("button")?.textContent).toContain("Copied");
		expect(order.actual_amount).toBe("59.8613");
	});

	it("does not claim success when clipboard write fails", async () => {
		await render(
			<BscWithdrawalNotice onCopyAmount={() => false} order={order} />,
		);
		await act(async () => container?.querySelector("button")?.click());
		expect(container?.querySelector("button")?.textContent).toBe(
			"Copy transfer amount",
		);
	});

	it("removes the helper when switching network and recalculates when the quote changes", async () => {
		const onCopy = vi.fn().mockResolvedValue(true);
		await render(<BscWithdrawalNotice onCopyAmount={onCopy} order={order} />);
		await render(
			<BscWithdrawalNotice
				onCopyAmount={onCopy}
				order={{ ...order, network: "tron" }}
			/>,
		);
		expect(container?.textContent).toBe("");
		await render(
			<BscWithdrawalNotice
				onCopyAmount={onCopy}
				order={{ ...order, actual_amount: "1.4950" }}
			/>,
		);
		await act(async () => container?.querySelector("button")?.click());
		expect(onCopy).toHaveBeenCalledExactlyOnceWith("1.5050");
	});

	it("hides incomplete BSC data instead of adding fees to the CNY price", async () => {
		const { actual_amount: _, ...incomplete } = order;
		await render(
			<BscWithdrawalNotice onCopyAmount={vi.fn()} order={incomplete} />,
		);
		expect(container?.textContent).toBe("");
	});

	it("preserves the existing icon-only copy control", async () => {
		const onCopy = vi.fn().mockResolvedValue(true);
		await render(<CopyIconButton onClick={onCopy} />);
		expect(container?.querySelector("button")?.getAttribute("aria-label")).toBe(
			"Copy",
		);
		expect(container?.querySelector("button")?.textContent).toBe("");
		await act(async () => container?.querySelector("button")?.click());
		expect(onCopy).toHaveBeenCalledOnce();
	});
});
