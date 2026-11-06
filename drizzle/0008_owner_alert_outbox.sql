CREATE TABLE `owner_alert_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `owner_alert_outbox_due_idx` ON `owner_alert_outbox` (`next_attempt_at`) WHERE "owner_alert_outbox"."sent_at" IS NULL;