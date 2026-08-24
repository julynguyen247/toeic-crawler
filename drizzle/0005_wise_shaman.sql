INSERT OR IGNORE INTO `entity_media` (`media_id`, `entity_type`, `entity_id`, `purpose`)
SELECT keeper.keep_id, link.entity_type, link.entity_id, link.purpose
FROM `entity_media` link
JOIN `media` duplicate ON duplicate.id = link.media_id
JOIN (
	SELECT canonical_url, MIN(id) AS keep_id
	FROM `media`
	WHERE canonical_url IS NOT NULL
	GROUP BY canonical_url
	HAVING COUNT(*) > 1
) keeper ON keeper.canonical_url = duplicate.canonical_url
WHERE duplicate.id != keeper.keep_id;--> statement-breakpoint
INSERT OR IGNORE INTO `content_record_media` (`content_record_id`, `media_id`, `purpose`)
SELECT link.content_record_id, keeper.keep_id, link.purpose
FROM `content_record_media` link
JOIN `media` duplicate ON duplicate.id = link.media_id
JOIN (
	SELECT canonical_url, MIN(id) AS keep_id
	FROM `media`
	WHERE canonical_url IS NOT NULL
	GROUP BY canonical_url
	HAVING COUNT(*) > 1
) keeper ON keeper.canonical_url = duplicate.canonical_url
WHERE duplicate.id != keeper.keep_id;--> statement-breakpoint
DELETE FROM `entity_media`
WHERE media_id IN (
	SELECT duplicate.id
	FROM `media` duplicate
	JOIN (
		SELECT canonical_url, MIN(id) AS keep_id
		FROM `media`
		WHERE canonical_url IS NOT NULL
		GROUP BY canonical_url
		HAVING COUNT(*) > 1
	) keeper ON keeper.canonical_url = duplicate.canonical_url
	WHERE duplicate.id != keeper.keep_id
);--> statement-breakpoint
DELETE FROM `content_record_media`
WHERE media_id IN (
	SELECT duplicate.id
	FROM `media` duplicate
	JOIN (
		SELECT canonical_url, MIN(id) AS keep_id
		FROM `media`
		WHERE canonical_url IS NOT NULL
		GROUP BY canonical_url
		HAVING COUNT(*) > 1
	) keeper ON keeper.canonical_url = duplicate.canonical_url
	WHERE duplicate.id != keeper.keep_id
);--> statement-breakpoint
DELETE FROM `media`
WHERE canonical_url IS NOT NULL
	AND id NOT IN (
		SELECT MIN(id)
		FROM `media`
		WHERE canonical_url IS NOT NULL
		GROUP BY canonical_url
	);--> statement-breakpoint
CREATE UNIQUE INDEX `media_canonical_url_unique` ON `media` (`canonical_url`);
