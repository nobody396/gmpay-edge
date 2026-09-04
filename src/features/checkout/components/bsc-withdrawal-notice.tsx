import { Info } from "lucide-react";
import { m } from "#/paraglide/messages";
import {
	BSC_WITHDRAWAL_FEE,
	bscWithdrawalAmount,
} from "../bsc-withdrawal-amount";
import type { CheckoutOrder } from "../checkout-model";
import { CopyIconButton } from "./checkout-display";

export function BscWithdrawalNotice({
	order,
	onCopyAmount,
}: {
	order: CheckoutOrder;
	onCopyAmount: (
		amount: string,
	) => boolean | undefined | Promise<boolean | undefined>;
}) {
	const transferAmount = bscWithdrawalAmount(order);
	if (!transferAmount) return null;

	return (
		<section
			aria-label={m.checkout_bsc_withdrawal_title()}
			className="mb-4 w-full rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
		>
			<p className="mb-3 flex items-center gap-2 font-semibold text-sm">
				<Info aria-hidden="true" className="size-4 shrink-0" />
				{m.checkout_bsc_withdrawal_title()}
			</p>
			<p className="text-sm">{m.checkout_bsc_withdrawal_amount_label()}</p>
			<p className="mt-1 break-all font-bold font-mono text-2xl">
				{transferAmount} USDT
			</p>
			<CopyIconButton
				className="mt-3 w-full"
				key={transferAmount}
				label={m.checkout_bsc_withdrawal_copy()}
				onClick={() => onCopyAmount(transferAmount)}
			/>
			<p className="mt-3 text-sm leading-relaxed">
				{m.checkout_bsc_withdrawal_assumption({ fee: BSC_WITHDRAWAL_FEE })}
			</p>
			<p className="mt-2 font-medium text-sm leading-relaxed">
				{m.checkout_bsc_withdrawal_check({ amount: order.actual_amount ?? "" })}
			</p>
		</section>
	);
}
