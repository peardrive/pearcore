CREATE TABLE `partial_download_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`registry_id` integer NOT NULL,
	`last_pushed_leaf` integer DEFAULT -1 NOT NULL,
	`final_destination` text NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `file_registry`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partial_download_record_registry_id_unique` ON `partial_download_record` (`registry_id`);--> statement-breakpoint
CREATE TABLE `file_index` (
	`file_registry_id` integer NOT NULL,
	`root_hash` text NOT NULL,
	`level` integer NOT NULL,
	`hash` text NOT NULL,
	`parent_hash` text,
	`left_child_hash` text,
	`right_child_hash` text,
	`node_index` integer NOT NULL,
	`leaf_index` integer,
	PRIMARY KEY(`file_registry_id`, `level`, `node_index`),
	FOREIGN KEY (`file_registry_id`) REFERENCES `file_registry`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `level_index` ON `file_index` (`level`);--> statement-breakpoint
CREATE INDEX `nodeIndex_index` ON `file_index` (`node_index`);--> statement-breakpoint
CREATE TABLE `file_registry` (
	`id` integer PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`timestamp` integer NOT NULL,
	`space_id` integer NOT NULL,
	`space_path` text NOT NULL,
	`space_filename` text NOT NULL,
	`root_hash` text,
	`meta_hash` text NOT NULL,
	`leaf_count` integer NOT NULL,
	`height` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`space_id` integer NOT NULL,
	`type` text NOT NULL,
	`sender_public_key` text NOT NULL,
	`broadcast_timestamp` integer NOT NULL,
	`message_owner_public_key` text NOT NULL,
	`timestamp` integer NOT NULL,
	`nonce` text NOT NULL,
	`signature` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_nonce_unique` ON `messages` (`nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_message_id_unique` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_space_range_index` ON `messages` (`space_id`,`timestamp`,`message_id`);--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`tag` text DEFAULT '' NOT NULL,
	`profile_url` text DEFAULT '',
	`public_key` text NOT NULL,
	`signature` text NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sharelinks` (
	`id` integer PRIMARY KEY NOT NULL,
	`space_name` text NOT NULL,
	`public_key` text NOT NULL,
	`nonce` text NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `broadcast_whitelist` (
	`id` integer PRIMARY KEY NOT NULL,
	`space_id` integer NOT NULL,
	`allowed_public_key` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `read_whitelist` (
	`id` integer PRIMARY KEY NOT NULL,
	`space_id` integer NOT NULL,
	`allowed_public_key` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` integer PRIMARY KEY NOT NULL,
	`space_name` text NOT NULL,
	`public_key` text NOT NULL,
	`timestamp` integer NOT NULL,
	`permission_broadcast` integer NOT NULL,
	`permission_read` integer NOT NULL,
	`signature` text NOT NULL,
	`nonce` text NOT NULL,
	`secret` text
);
