CREATE TABLE `replay_frames` (
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`frame` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replay_frames_session_version` ON `replay_frames` (`session_id`,`version`);