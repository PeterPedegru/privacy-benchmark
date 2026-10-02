CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_slug" text NOT NULL,
	"criterion_id" text,
	"message" text NOT NULL,
	"evidence_url" text,
	"contact" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"decision_note" text,
	"decided_at" text,
	"release_id" text
);
--> statement-breakpoint
CREATE TABLE "criterion_results" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"criterion_id" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"option_id" text,
	"rationale" text DEFAULT '' NOT NULL,
	"confidence" text DEFAULT 'low' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decisive_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_log" jsonb,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_note" text,
	"accepted_flags" jsonb,
	"reviewed_at" text,
	"proposed_option_id" text,
	"change" jsonb,
	"override_status" text,
	"override_option_id" text,
	"override_reason" text,
	"overridden_at" text,
	"updated_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"project_id" text NOT NULL,
	"version_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'intake' NOT NULL,
	"completed_stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text DEFAULT 'standard' NOT NULL,
	"suite_filter" jsonb,
	"summary" text DEFAULT '' NOT NULL,
	"powers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary_at" text,
	"adversary_matrix" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_suites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"criterion_id" text NOT NULL,
	"claim" text DEFAULT '' NOT NULL,
	"quote" text NOT NULL,
	"source_id" text,
	"url" text DEFAULT '' NOT NULL,
	"cited_url" text,
	"stance" text DEFAULT 'context' NOT NULL,
	"source_class" text DEFAULT 'official_docs' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verify_method" text DEFAULT 'none' NOT NULL,
	"verify_note" text,
	"quote_context" text,
	"agent_quote" text,
	"created_by_stage" text DEFAULT 'research' NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" text NOT NULL,
	"label" text NOT NULL,
	"released_at" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"repo" text,
	"tag" text,
	"is_major" boolean DEFAULT false NOT NULL,
	"is_prerelease" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"privacy_relevant" boolean DEFAULT false NOT NULL,
	"affected_suites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relevance_note" text DEFAULT '' NOT NULL,
	"notes_md" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"checked_at" text,
	"deployment" jsonb
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"website_url" text NOT NULL,
	"logo_url" text,
	"tagline" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"mechanism" text DEFAULT 'none' NOT NULL,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"l2beat_slug" text,
	"defillama_slug" text,
	"github_repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"x_handle" text,
	"x_handle_source" text,
	"docs_url" text,
	"kb_status" text DEFAULT 'empty' NOT NULL,
	"kb_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kb_refreshed_at" text,
	"kb_version_id" text,
	"kb_error" text,
	"docs_roots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"news_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kb_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"track_versions" boolean DEFAULT true NOT NULL,
	"version_tag_pattern" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_results" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"project_id" text NOT NULL,
	"evaluation_id" text,
	"version_id" text,
	"overall" double precision,
	"level" text,
	"trust_tier" text,
	"walkaway" boolean,
	"active" boolean DEFAULT true NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"rubric_version" text NOT NULL,
	"notes_md" text DEFAULT '' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"eval_settings" jsonb,
	"published_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"run_id" text,
	"ts" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"rubric_version" text NOT NULL,
	"mode" text DEFAULT 'standard' NOT NULL,
	"suite_filter" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "search_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"criterion_id" text NOT NULL,
	"searched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_stage" text NOT NULL,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'docs' NOT NULL,
	"source_class" text DEFAULT 'official_docs' NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"content_hash" text,
	"content_len" integer GENERATED ALWAYS AS (length(content_md)) STORED,
	"http_status" integer,
	"origin" text DEFAULT 'admin' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"date" text,
	"fetched_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "version_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"ran_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"repos_checked" integer DEFAULT 0 NOT NULL,
	"new_versions" integer DEFAULT 0 NOT NULL,
	"error" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_logs" ADD CONSTRAINT "search_logs_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_checks" ADD CONSTRAINT "version_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "criterion_results_eval_crit_idx" ON "criterion_results" USING btree ("evaluation_id","criterion_id");--> statement-breakpoint
CREATE INDEX "evaluations_project_idx" ON "evaluations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evaluations_status_idx" ON "evaluations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evaluations_run_idx" ON "evaluations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluations_version_idx" ON "evaluations" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "evidence_eval_idx" ON "evidence" USING btree ("evaluation_id","criterion_id");--> statement-breakpoint
CREATE INDEX "evidence_source_idx" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_versions_project_version_idx" ON "project_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "project_versions_status_idx" ON "project_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "published_project_idx" ON "published_results" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "published_release_idx" ON "published_results" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "published_active_project_idx" ON "published_results" USING btree ("active","project_id");--> statement-breakpoint
CREATE INDEX "published_project_created_idx" ON "published_results" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "published_evaluation_idx" ON "published_results" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "published_version_idx" ON "published_results" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "run_events_eval_idx" ON "run_events" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "search_logs_eval_idx" ON "search_logs" USING btree ("evaluation_id","criterion_id");--> statement-breakpoint
CREATE INDEX "sources_project_idx" ON "sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_project_url_idx" ON "sources" USING btree ("project_id","url");--> statement-breakpoint
CREATE INDEX "sources_project_kind_idx" ON "sources" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "sources_project_hash_idx" ON "sources" USING btree ("project_id","content_hash");--> statement-breakpoint
CREATE INDEX "version_checks_project_ran_idx" ON "version_checks" USING btree ("project_id","ran_at");