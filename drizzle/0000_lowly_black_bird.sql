CREATE TABLE `choices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`choice_key` text NOT NULL,
	`content_html` text,
	`content_text` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `choices_question_key_unique` ON `choices` (`question_id`,`choice_key`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_system` text DEFAULT 'dautoeic' NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`source_url` text,
	`source_updated_at` text,
	`first_seen_run_id` text,
	`last_seen_run_id` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`content_hash` text,
	`missing_from_source` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_source_unique` ON `collections` (`source_system`,`source_id`);--> statement-breakpoint
CREATE TABLE `crawl_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	`tests_discovered` integer DEFAULT 0 NOT NULL,
	`tests_succeeded` integer DEFAULT 0 NOT NULL,
	`tests_failed` integer DEFAULT 0 NOT NULL,
	`questions_saved` integer DEFAULT 0 NOT NULL,
	`media_saved` integer DEFAULT 0 NOT NULL,
	`read_only` integer DEFAULT true NOT NULL,
	`source_mutations_json` text DEFAULT '[]' NOT NULL,
	`error_summary_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_media` (
	`media_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`purpose` text NOT NULL,
	PRIMARY KEY(`media_id`, `entity_type`, `entity_id`, `purpose`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`bucket` text,
	`object_path` text,
	`canonical_url` text,
	`local_path` text,
	`media_type` text NOT NULL,
	`mime_type` text,
	`sha256` text,
	`byte_size` integer,
	`download_status` text DEFAULT 'pending' NOT NULL,
	`last_downloaded_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_storage_locator_unique` ON `media` (`provider`,`bucket`,`object_path`);--> statement-breakpoint
CREATE INDEX `media_sha256_idx` ON `media` (`sha256`);--> statement-breakpoint
CREATE INDEX `media_download_status_idx` ON `media` (`download_status`);--> statement-breakpoint
CREATE TABLE `parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_id` integer NOT NULL,
	`part_number` integer NOT NULL,
	`title` text,
	`instructions` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parts_test_number_unique` ON `parts` (`test_id`,`part_number`);--> statement-breakpoint
CREATE TABLE `question_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`source_id` text,
	`content_html` text,
	`content_text` text,
	`transcript` text,
	`translation` text,
	`position` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_part_source_unique` ON `question_groups` (`part_id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `groups_part_position_hash_unique` ON `question_groups` (`part_id`,`position`,`content_hash`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`group_id` integer,
	`source_id` text,
	`question_number` integer NOT NULL,
	`prompt_html` text,
	`prompt_text` text,
	`correct_choice_key` text,
	`explanation_html` text,
	`explanation_text` text,
	`evidence` text,
	`position` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `question_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_test_source_unique` ON `questions` (`test_id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `questions_test_number_unique` ON `questions` (`test_id`,`question_number`);--> statement-breakpoint
CREATE TABLE `source_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`crawl_run_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_source_id` text NOT NULL,
	`payload_path` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`redaction_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`crawl_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_run_entity_hash_unique` ON `source_snapshots` (`crawl_run_id`,`entity_type`,`entity_source_id`,`payload_sha256`);--> statement-breakpoint
CREATE TABLE `tests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`difficulty` text,
	`question_count` integer,
	`source_url` text,
	`source_updated_at` text,
	`content_hash` text,
	`crawl_status` text DEFAULT 'pending' NOT NULL,
	`crawled_at` text,
	`first_seen_run_id` text,
	`last_seen_run_id` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`missing_from_source` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tests_collection_source_unique` ON `tests` (`collection_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `tests_status_idx` ON `tests` (`crawl_status`);