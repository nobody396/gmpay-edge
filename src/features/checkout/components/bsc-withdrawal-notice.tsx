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
	const invoiceAmount = order.actual_amount ?? "";

	return (
		<section
			aria-label={m.checkout_bsc_withdrawal_title()}
			className="mb-4 w-full rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
		>
			<p className="mb-3 flex items-center gap-2 font-semibold text-sm">
				<Info aria-hidden="true" className="size-4 shrink-0" />
				{m.checkout_bsc_withdrawal_title()}
			</p>
			<p className="text-sm leading-relaxed">
				{m.checkout_bsc_withdrawal_intro()}
			</p>
			<div className="mt-4 grid gap-3 sm:grid-cols-2">
				<div className="rounded-xl border border-amber-300/80 bg-white/70 p-4 dark:border-amber-800 dark:bg-amber-950/20">
					<p className="font-semibold text-sm">
						{m.checkout_bsc_wallet_title()}
					</p>
					<p className="mt-1 min-h-10 text-xs leading-relaxed opacity-80">
						{m.checkout_bsc_wallet_description()}
					</p>
					<p className="mt-3 text-xs">{m.checkout_bsc_wallet_amount_label()}</p>
					<p className="mt-1 break-all font-bold font-mono text-xl">
						{invoiceAmount} USDT
					</p>
					<CopyIconButton
						className="mt-3 w-full"
						key={`wallet-${invoiceAmount}`}
						label={m.checkout_bsc_wallet_copy()}
						onClick={() => onCopyAmount(invoiceAmount)}
					/>
				</div>
				<div className="rounded-xl border border-amber-300/80 bg-white/70 p-4 dark:border-amber-800 dark:bg-amber-950/20">
					<p className="font-semibold text-sm">
						{m.checkout_bsc_exchange_title()}
					</p>
					<p className="mt-1 min-h-10 text-xs leading-relaxed opacity-80">
						{m.checkout_bsc_exchange_description({
							fee: BSC_WITHDRAWAL_FEE,
						})}
					</p>
					<p className="mt-3 text-xs">
						{m.checkout_bsc_exchange_amount_label()}
					</p>
					<p className="mt-1 break-all font-bold font-mono text-xl">
						{transferAmount} USDT
					</p>
					<CopyIconButton
						className="mt-3 w-full"
						key={`exchange-${transferAmount}`}
						label={m.checkout_bsc_exchange_copy()}
						onClick={() => onCopyAmount(transferAmount)}
					/>
				</div>
			</div>
			<p className="mt-2 font-medium text-sm leading-relaxed">
				{m.checkout_bsc_withdrawal_check({ amount: invoiceAmount })}
			</p>
		</section>
	);
}
