ALTER TABLE `question_groups` ADD `image_alt_text` text;--> statement-breakpoint
ALTER TABLE `question_groups` ADD `image_alt_source` text;--> statement-breakpoint
ALTER TABLE `question_groups` ADD `image_alt_needs_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `question_groups` ADD `image_alt_version` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `image_alt_source` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `image_alt_needs_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `image_alt_version` text;