CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_username_unique` ON `profiles` (`username_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week` text NOT NULL,
	`mode` text NOT NULL,
	`ranked` integer NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`lock_token` text,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`final_pnl` integer,
	`provider_calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_week` ON `sessions` (`user_id`,`week`);--> statement-breakpoint
CREATE INDEX `sessions_leaderboard` ON `sessions` (`week`,`mode`,`status`);