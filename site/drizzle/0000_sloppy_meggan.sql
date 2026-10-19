CREATE TABLE `access_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result_key` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_jobs_owner_idx` ON `ai_jobs` (`owner_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_jobs_kind_idx` ON `ai_jobs` (`kind`,`status`);