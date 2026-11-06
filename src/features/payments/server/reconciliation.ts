import type { OrderStatus } from "#/features/orders/schema";
import { statusFromPayment } from "#/features/orders/state-machine";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";

export interface PaymentAggregate {
	amountUnits: bigint;
	confirmations: number;
	status: "detected" | "confirming" | "confirmed" | "reorged" | "rejected";
}

export function reconcileOrderPayment(input: {
	expectedUnits: bigint;
	payments: readonly PaymentAggregate[];
	requiredConfirmations: number;
	underpaymentToleranceUnits?: bigint;
}): { receivedUnits: bigint; confirmedUnits: bigint; status: OrderStatus } {
	const tolerance = input.underpaymentToleranceUnits ?? 0n;
	let receivedUnits = 0n;
	let confirmedUnits = 0n;
	for (const payment of input.payments) {
		if (payment.status === "reorged" || payment.status === "rejected") continue;
		receivedUnits += payment.amountUnits;
		if (
			payment.status === "confirmed" ||
			payment.confirmations >= input.requiredConfirmations
		) {
			confirmedUnits += payment.amountUnits;
		}
	}

	const status = statusFromPayment(
		input.expectedUnits,
		receivedUnits,
		confirmedUnits >= input.expectedUnits - tolerance
			? input.requiredConfirmations
			: 0,
		input.requiredConfirmations,
		tolerance,
	);
	return { receivedUnits, confirmedUnits, status };
}

export class PaymentAttributionConflictError extends DomainError {
	constructor() {
		super(
			"transaction_already_attributed",
			409,
			"Transaction is already attributed to another order",
		);
		this.name = "PaymentAttributionConflictError";
	}
}

export function paymentTransactionId(
	transaction: Pick<NormalizedTransaction, "network" | "hash" | "eventIndex">,
) {
	return `${transaction.network}:${transaction.hash}:${transaction.eventIndex}`;
}

export function parsePaymentTransactionId(value: string) {
	const firstSeparator = value.indexOf(":");
	const lastSeparator = value.lastIndexOf(":");
	if (firstSeparator <= 0 || lastSeparator <= firstSeparator) {
		throw new Error("Invalid payment transaction identifier");
	}
	return {
		hash: value.slice(firstSeparator + 1, lastSeparator),
		eventIndex: Number(value.slice(lastSeparator + 1)),
	};
}
