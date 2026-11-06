import { createFileRoute } from "@tanstack/react-router";
import { claimCheckoutRateLimit } from "#/features/checkout/server/rate-limit";
import { mapCheckoutReviewError } from "#/features/checkout/server/review-errors";
import { autoApprovePaymentReview } from "#/features/payment-reviews/server/auto-approve";
import {
	createPaymentReview,
	PaymentReviewError,
} from "#/features/payment-reviews/server/create";
import { alertPaymentReviewSubmitted } from "#/features/payments/server/owner-alert";
import { isSameOriginRequest } from "#/server/api-boundaries";
import { getEnv } from "#/server/db.server";
import { json, withRequestId } from "#/server/http";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024 + 64 * 1024;

export const Route = createFileRoute("/api/checkout/$orderId/review")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const env = getEnv();
				if (!isSameOriginRequest(request))
					return response(request, "origin_forbidden", 403);
				if (!env.FILES) return response(request, "storage_unavailable", 503);
				try {
					await enforceReviewRateLimit(env, request, params.orderId);
				} catch (error) {
					const mapped = mapCheckoutReviewError(error);
					return response(request, mapped.code, mapped.status);
				}
				let form: FormData;
				try {
					const bytes = await readLimitedRequestBytes(
						request,
						MAX_REQUEST_BYTES,
					);
					form = await new Response(bytes.buffer, {
						headers: {
							"content-type": request.headers.get("content-type") ?? "",
						},
					}).formData();
					const entries = [...form.entries()];
					if (
						entries.length > 8 ||
						entries.filter(([, value]) => value instanceof File).length > 1
					)
						return response(request, "invalid_evidence", 422);
				} catch (error) {
					if (error instanceof RequestBodyTooLargeError)
						return response(request, "invalid_evidence", 413);
					return response(request, "invalid_request", 400);
				}
				try {
					const evidence = form.get("evidence");
					if (!(evidence instanceof File))
						return response(request, "invalid_evidence", 422);
					const review = {
						orderId: params.orderId,
						description: String(form.get("description") ?? "").trim(),
						transactionHash:
							String(form.get("transactionHash") ?? "").trim() || undefined,
					};
					const result = await createPaymentReview(
						{
							...review,
							evidence: await evidence.arrayBuffer(),
							claimedContentType: evidence.type,
						},
						{
							db: env.DB,
							bucket: env.FILES,
							requestId: request.headers.get("x-request-id"),
							ipAddress: request.headers.get("cf-connecting-ip"),
						},
					);
					// A verifiable, settling transaction needs no person; the
					// owner still gets one message either way.
					const automatic = await autoApprovePaymentReview(
						env,
						result.id,
					).catch(() => ({ approved: false }));
					if (!automatic.approved)
						await alertPaymentReviewSubmitted(env, review);
					return withRequestId(
						request,
						json(
							{
								data: automatic.approved
									? { ...result, status: "approved" as const }
									: result,
							},
							{ status: 201 },
						),
					);
				} catch (error) {
					const mapped = mapCheckoutReviewError(error);
					return response(request, mapped.code, mapped.status);
				}
			},
		},
	},
});

async function enforceReviewRateLimit(
	env: Env,
	request: Request,
	orderId: string,
) {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const result = await claimCheckoutRateLimit(env.DB, {
		action: "review",
		orderId,
		clientAddress: ip,
	});
	if (!result.allowed) throw new PaymentReviewError("rate_limited", 429);
}

function response(request: Request, code: string, status: number) {
	return withRequestId(request, json({ error: { code } }, { status }));
}
