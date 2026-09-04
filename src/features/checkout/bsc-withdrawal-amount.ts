import { decimalToUnits, unitsToDecimal } from "#/lib/money";
import type { CheckoutOrder } from "./checkout-model";

export const BSC_WITHDRAWAL_FEE = "0.01";
const BSC_USDT_DECIMALS = 18;

// An input helper for fees deducted from the entered amount, not a new invoice
// amount or a live exchange fee quote. Never use this value for settlement.
export function bscWithdrawalAmount(
	order: Pick<CheckoutOrder, "network" | "token" | "actual_amount">,
): string | null {
	if (
		order.network?.toLowerCase() !== "bsc" ||
		order.token?.toUpperCase() !== "USDT" ||
		!order.actual_amount
	)
		return null;

	try {
		const dueUnits = decimalToUnits(order.actual_amount, BSC_USDT_DECIMALS);
		if (dueUnits <= 0n) return null;
		const feeUnits = decimalToUnits(BSC_WITHDRAWAL_FEE, BSC_USDT_DECIMALS);
		const amount = unitsToDecimal(dueUnits + feeUnits, BSC_USDT_DECIMALS);
		const [whole, fraction = ""] = amount.split(".");
		return `${whole}.${fraction.padEnd(4, "0")}`;
	} catch {
		// Incomplete or invalid checkout data must not produce a payable amount.
		return null;
	}
}
