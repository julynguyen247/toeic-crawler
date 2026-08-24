CREATE TABLE `content_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_table` text NOT NULL,
	`source_id` text NOT NULL,
	`parent_source_id` text,
	`content_type` text NOT NULL,
	`title` text,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_updated_at` text,
	`first_seen_run_id` text,
	`last_seen_run_id` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`missing_from_source` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_records_source_unique` ON `content_records` (`source_table`,`source_id`);--> statement-breakpoint
CREATE INDEX `content_records_type_idx` ON `content_records` (`content_type`);--> statement-breakpoint
CREATE INDEX `content_records_parent_idx` ON `content_records` (`parent_source_id`);