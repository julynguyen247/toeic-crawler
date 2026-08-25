ALTER TABLE `questions` ADD `explanation_source` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `image_alt_text` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `skill_tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `skill_tag_version` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `enrichment_version` text;