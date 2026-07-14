CREATE TABLE `hunt` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`query` text NOT NULL,
	`target_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`watch_id` text,
	`channel_id` text NOT NULL,
	`error` text,
	`cost_cents` integer,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hunt_claimable` ON `hunt` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `hunt_result` (
	`hunt_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`rank` integer NOT NULL,
	`landed_cost_cents` integer,
	`verdict` text,
	PRIMARY KEY(`hunt_id`, `listing_id`),
	FOREIGN KEY (`hunt_id`) REFERENCES `hunt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listing`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `listing` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`price_cents` integer,
	`shipping_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`condition` text,
	`seller_rating` real,
	`location` text,
	`image_url` text,
	`raw_json` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_listing_source` ON `listing` (`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_source_source_id` ON `listing` (`source`,`source_id`);--> statement-breakpoint
CREATE TABLE `profile_fact` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watch` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target_json` text NOT NULL,
	`cadence_minutes` integer DEFAULT 1440 NOT NULL,
	`next_run_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`channel_id` text NOT NULL,
	`last_run_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_watch_due` ON `watch` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `watch_hit` (
	`watch_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`notified_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`watch_id`, `listing_id`),
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listing`(`id`) ON UPDATE no action ON DELETE no action
);
