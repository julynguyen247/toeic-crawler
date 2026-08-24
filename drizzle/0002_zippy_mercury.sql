CREATE TABLE `content_record_media` (
	`content_record_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`purpose` text NOT NULL,
	PRIMARY KEY(`content_record_id`, `media_id`, `purpose`),
	FOREIGN KEY (`content_record_id`) REFERENCES `content_records`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
