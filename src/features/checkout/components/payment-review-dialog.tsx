import { FileCheck, LoaderCircle, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Input, Textarea } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { m } from "#/paraglide/messages";

export function PaymentReviewDialog({
	disabled,
	onSubmitted,
	orderId,
	transactionHash,
}: {
	disabled?: boolean;
	onSubmitted: () => void;
	orderId: string;
	transactionHash: string;
}) {
	const [open, setOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [description, setDescription] = useState("");
	const [evidence, setEvidence] = useState<File | null>(null);

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger asChild>
				<Button
					className="mb-3 h-12 w-full rounded-xl text-base"
					disabled={disabled}
					type="button"
					variant="outline"
				>
					<FileCheck />
					{disabled ? m.checkout_review_pending() : m.checkout_review_title()}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{m.checkout_review_title()}</DialogTitle>
					<DialogDescription>
						{m.checkout_review_description()}
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!evidence || description.trim().length < 10) {
							toast.error(m.checkout_review_required());
							return;
						}
						setSubmitting(true);
						try {
							const form = new FormData();
							form.set("description", description.trim());
							form.set("evidence", evidence);
							if (transactionHash.trim())
								form.set("transactionHash", transactionHash.trim());
							const response = await fetch(
								`/api/checkout/${encodeURIComponent(orderId)}/review`,
								{ method: "POST", body: form },
							);
							if (!response.ok) throw new Error("review_failed");
							const body = (await response.json().catch(() => null)) as {
								data?: { status?: string };
							} | null;
							toast.success(m.checkout_review_submitted());
							setOpen(false);
							// A verified hash can settle the order on the spot; reload the
							// authoritative order so the page shows payment and redirects.
							if (body?.data?.status === "approved") {
								window.location.reload();
								return;
							}
							onSubmitted();
						} catch {
							toast.error(m.checkout_review_failed());
						} finally {
							setSubmitting(false);
						}
					}}
				>
					<div className="space-y-2">
						<label className="font-medium text-sm" htmlFor="review-description">
							{m.checkout_review_details_label()}
						</label>
						<Textarea
							className="min-h-24"
							disabled={submitting}
							id="review-description"
							maxLength={1000}
							onChange={(event) => setDescription(event.target.value)}
							placeholder={m.checkout_review_details_placeholder()}
							required
							value={description}
						/>
					</div>
					<div className="space-y-2">
						<label className="font-medium text-sm" htmlFor="review-evidence">
							{m.checkout_review_evidence_label()}
						</label>
						<Input
							accept="image/jpeg,image/png,image/webp"
							disabled={submitting}
							id="review-evidence"
							onChange={(event) =>
								setEvidence(event.target.files?.item(0) ?? null)
							}
							required
							type="file"
						/>
						<p className="text-muted-foreground text-xs">
							{m.checkout_review_evidence_hint()}
						</p>
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button disabled={submitting} type="button" variant="outline">
								{m.common_cancel()}
							</Button>
						</DialogClose>
						<Button disabled={submitting} type="submit">
							{submitting ? (
								<LoaderCircle className="animate-spin" />
							) : (
								<Send />
							)}
							{m.checkout_review_submit()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
