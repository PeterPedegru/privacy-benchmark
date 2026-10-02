ALTER TABLE `projects` ADD `x_handle` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `docs_url` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `kb_status` text DEFAULT 'empty' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `kb_stats` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `kb_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `kb_version_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `kb_error` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `meta` text DEFAULT '{}' NOT NULL;