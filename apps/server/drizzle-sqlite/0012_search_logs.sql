CREATE TABLE `search_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`searched` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by_stage` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_logs_eval_idx` ON `search_logs` (`evaluation_id`,`criterion_id`);--> statement-breakpoint
ALTER TABLE `criterion_results` ADD `search_log` text;