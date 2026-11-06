import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getCheckoutOrderWithDatabase } from "#/features/checkout/server/checkout-order";
import {
	listCheckoutPaymentOptions,
	paymentOptionInput,
} from "#/features/checkout/server/payment-options";
import {
	selectCheckoutPaymentOptionForRequest,
	submitCheckoutTransactionForRequest,
} from "#/features/checkout/server/request-actions";
import { orderIdPathSchema } from "#/features/orders/schema";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";

export const getCheckoutOrderFn = createServerFn({ method: "GET" })
	.validator((input: { orderId: string }) =>
		z.object({ orderId: z.string().max(128) }).parse(input),
	)
	.handler(async ({ data }) => {
		if (!orderIdPathSchema.safeParse(data.orderId).success) return null;
		const request = getRequest();
		const db = getCloudflareEnv(request)?.DB;
		if (!db)
			throw new DomainError(
				"checkout_unavailable",
				503,
				"Checkout is unavailable",
			);

		return getCheckoutOrderWithDatabase(db, data.orderId);
	});

export const submitCheckoutTransactionFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			orderId: orderIdPathSchema,
			transactionHash: z.string().trim().min(8).max(256),
		}),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const env = getCloudflareEnv(request);
		if (!(env.DB && env.WEBHOOK_QUEUE))
			throw new DomainError(
				"checkout_unavailable",
				503,
				"Checkout is unavailable",
			);
		return submitCheckoutTransactionForRequest(
			{
				DB: env.DB,
				WEBHOOK_QUEUE: env.WEBHOOK_QUEUE,
				// Automatic settlements from a submitted hash notify the owner too.
				OWNER_ALERT_TELEGRAM_BOT_TOKEN: env.OWNER_ALERT_TELEGRAM_BOT_TOKEN,
				OWNER_ALERT_TELEGRAM_CHAT_ID: env.OWNER_ALERT_TELEGRAM_CHAT_ID,
				OWNER_ALERT_TELEGRAM_THREAD_ID: env.OWNER_ALERT_TELEGRAM_THREAD_ID,
			},
			data,
			request.headers.get("cf-connecting-ip") ?? "unknown",
		);
	});

export const listCheckoutPaymentOptionsFn = createServerFn({ method: "GET" })
	.validator((input: { orderId: string }) =>
		z.object({ orderId: orderIdPathSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		const db = getCloudflareEnv(getRequest()).DB;
		if (!db)
			throw new DomainError(
				"checkout_unavailable",
				503,
				"Checkout is unavailable",
			);
		return listCheckoutPaymentOptions(db, data.orderId);
	});

export const selectCheckoutPaymentOptionFn = createServerFn({ method: "POST" })
	.validator(paymentOptionInput)
	.handler(async ({ data }) => {
		const request = getRequest();
		const env = getCloudflareEnv(request);
		if (!env.DB)
			throw new DomainError(
				"checkout_unavailable",
				503,
				"Checkout is unavailable",
			);
		return selectCheckoutPaymentOptionForRequest(
			{ DB: env.DB },
			data,
			request.headers.get("cf-connecting-ip") ?? "unknown",
		);
	});
