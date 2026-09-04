import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

const COPY_RESET_DELAY = 1400;

export function formatRemaining(totalSeconds: number) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function CopyIconButton({
	className,
	label,
	onClick,
}: {
	className?: string;
	label?: string;
	onClick: () => boolean | undefined | Promise<boolean | undefined>;
}) {
	const [copied, setCopied] = useState(false);
	const resetTimerRef = useRef<number | undefined>(undefined);

	useEffect(
		() => () => {
			if (resetTimerRef.current !== undefined) {
				window.clearTimeout(resetTimerRef.current);
			}
		},
		[],
	);

	const handleClick = async () => {
		if (resetTimerRef.current !== undefined) {
			window.clearTimeout(resetTimerRef.current);
		}

		if ((await onClick()) === false) {
			setCopied(false);
			return;
		}

		setCopied(true);
		resetTimerRef.current = window.setTimeout(() => {
			setCopied(false);
			resetTimerRef.current = undefined;
		}, COPY_RESET_DELAY);
	};

	return (
		<Button
			aria-label={copied ? m.common_copy_success() : (label ?? m.common_copy())}
			className={cn("mb-0.5 shrink-0", className)}
			onClick={handleClick}
			size={label ? "default" : "icon-sm"}
			type="button"
			variant="secondary"
		>
			{copied ? (
				<Check className="text-emerald-600 dark:text-emerald-400" />
			) : (
				<Copy />
			)}
			{label ? (copied ? m.common_copy_success() : label) : null}
		</Button>
	);
}
