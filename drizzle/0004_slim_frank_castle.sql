ALTER TABLE `question_groups` ADD `source_payload_json` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `explanation_vi` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `explanation_en` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `translation` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `answer_translation` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `vocabulary` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `difficulty_level` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `section` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `source` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `pilot_status` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `source_payload_json` text;--> statement-breakpoint
ALTER TABLE `tests` ADD `media_folder` text;--> statement-breakpoint
ALTER TABLE `tests` ADD `media_version` text;--> statement-breakpoint
ALTER TABLE `tests` ADD `source_payload_json` text;