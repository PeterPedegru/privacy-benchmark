CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_slug` text NOT NULL,
	`criterion_id` text,
	`message` text NOT NULL,
	`evidence_url` text,
	`contact` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `criterion_results` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`option_id` text,
	`rationale` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT 'low' NOT NULL,
	`evidence_ids` text DEFAULT '[]' NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`votes` text DEFAULT '[]' NOT NULL,
	`override_status` text,
	`override_option_id` text,
	`override_reason` text,
	`overridden_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `criterion_results_eval_crit_idx` ON `criterion_results` (`evaluation_id`,`criterion_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`project_id` text NOT NULL,
	`version_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'intake' NOT NULL,
	`completed_stages` text DEFAULT '[]' NOT NULL,
	`mode` text DEFAULT 'standard' NOT NULL,
	`suite_filter` text,
	`summary` text DEFAULT '' NOT NULL,
	`powers` text DEFAULT '[]' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`adversary_matrix` text DEFAULT '{}' NOT NULL,
	`reviewed_suites` text DEFAULT '[]' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`error` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`usage` text DEFAULT '{}' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evaluations_project_idx` ON `evaluations` (`project_id`);--> statement-breakpoint
CREATE INDEX `evaluations_status_idx` ON `evaluations` (`status`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`claim` text DEFAULT '' NOT NULL,
	`quote` text NOT NULL,
	`source_id` text,
	`url` text DEFAULT '' NOT NULL,
	`cited_url` text,
	`stance` text DEFAULT 'context' NOT NULL,
	`source_class` text DEFAULT 'official_docs' NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verify_method` text DEFAULT 'none' NOT NULL,
	`verify_note` text,
	`created_by_stage` text DEFAULT 'research' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_eval_idx` ON `evidence` (`evaluation_id`,`criterion_id`);--> statement-breakpoint
CREATE TABLE `project_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` text NOT NULL,
	`label` text NOT NULL,
	`released_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_url` text,
	`repo` text,
	`tag` text,
	`is_major` integer DEFAULT false NOT NULL,
	`is_prerelease` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`privacy_relevant` integer DEFAULT false NOT NULL,
	`affected_suites` text DEFAULT '[]' NOT NULL,
	`relevance_note` text DEFAULT '' NOT NULL,
	`notes_md` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`checked_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_versions_project_version_idx` ON `project_versions` (`project_id`,`version`);--> statement-breakpoint
CREATE INDEX `project_versions_status_idx` ON `project_versions` (`status`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`website_url` text NOT NULL,
	`logo_url` text,
	`tagline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`mechanism` text DEFAULT 'none' NOT NULL,
	`attributes` text DEFAULT '[]' NOT NULL,
	`chains` text DEFAULT '[]' NOT NULL,
	`l2beat_slug` text,
	`defillama_slug` text,
	`github_repos` text DEFAULT '[]' NOT NULL,
	`track_versions` integer DEFAULT true NOT NULL,
	`version_tag_pattern` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_idx` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `published_results` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`project_id` text NOT NULL,
	`evaluation_id` text,
	`version_id` text,
	`overall` real,
	`level` text,
	`trust_tier` text,
	`walkaway` integer,
	`active` integer DEFAULT true NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `published_project_idx` ON `published_results` (`project_id`);--> statement-breakpoint
CREATE INDEX `published_release_idx` ON `published_results` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`rubric_version` text NOT NULL,
	`notes_md` text DEFAULT '' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`eval_settings` text,
	`published_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evaluation_id` text NOT NULL,
	`run_id` text,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`stage` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_eval_idx` ON `run_events` (`evaluation_id`);--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`rubric_version` text NOT NULL,
	`mode` text DEFAULT 'standard' NOT NULL,
	`suite_filter` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`usage` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'docs' NOT NULL,
	`source_class` text DEFAULT 'official_docs' NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`content_hash` text,
	`http_status` integer,
	`origin` text DEFAULT 'admin' NOT NULL,
	`date` text,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sources_project_idx` ON `sources` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_project_url_idx` ON `sources` (`project_id`,`url`);--> statement-breakpoint
CREATE TABLE `version_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`ran_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`repos_checked` integer DEFAULT 0 NOT NULL,
	`new_versions` integer DEFAULT 0 NOT NULL,
	`error` text,
	`usage` text DEFAULT '{}' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
