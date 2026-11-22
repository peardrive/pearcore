PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `file_index` WHERE `file_registry_id` IN (SELECT `id` FROM `file_registry` WHERE `root_hash` IS NULL);--> statement-breakpoint
DELETE FROM `partial_download_record` WHERE `registry_id` IN (SELECT `id` FROM `file_registry` WHERE `root_hash` IS NULL);--> statement-breakpoint
DELETE FROM `file_registry` WHERE `root_hash` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_file_registry` (
	`id` integer PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`timestamp` integer NOT NULL,
	`space_id` integer NOT NULL,
	`space_path` text NOT NULL,
	`space_filename` text NOT NULL,
	`root_hash` text NOT NULL,
	`meta_hash` text NOT NULL,
	`leaf_count` integer NOT NULL,
	`height` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_file_registry`("id", "file_path", "timestamp", "space_id", "space_path", "space_filename", "root_hash", "meta_hash", "leaf_count", "height") SELECT "id", "file_path", "timestamp", "space_id", "space_path", "space_filename", "root_hash", "meta_hash", "leaf_count", "height" FROM `file_registry`;--> statement-breakpoint
DROP TABLE `file_registry`;--> statement-breakpoint
ALTER TABLE `__new_file_registry` RENAME TO `file_registry`;--> statement-breakpoint
PRAGMA foreign_keys=ON;