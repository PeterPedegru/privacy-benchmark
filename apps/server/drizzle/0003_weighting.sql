CREATE TABLE "weighting_ballots" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"voter_hash" text NOT NULL,
	"voter_kind" text NOT NULL,
	"network_hash" text,
	"ballot" jsonb NOT NULL,
	"changes" integer DEFAULT 0 NOT NULL,
	"revisions" integer DEFAULT 0 NOT NULL,
	"withdrawn_at" text,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weighting_polls" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_id" text NOT NULL,
	"opens_at" text NOT NULL,
	"closes_at" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"require_x" boolean DEFAULT true NOT NULL,
	"min_ballots" integer DEFAULT 10 NOT NULL,
	"salt" text NOT NULL,
	"ballots" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"result_id" text,
	"stats" jsonb,
	"closed_at" text,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weightings" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"rubric_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"hash" text NOT NULL,
	"base_id" text,
	"poll_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"retired_at" text,
	"created_at" text DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "weighting_id" text;--> statement-breakpoint
ALTER TABLE "published_results" ADD COLUMN "weighting_id" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "weighting_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "weighting_id" text;--> statement-breakpoint
ALTER TABLE "weighting_ballots" ADD CONSTRAINT "weighting_ballots_poll_id_weighting_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."weighting_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighting_polls" ADD CONSTRAINT "weighting_polls_base_id_weightings_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighting_polls" ADD CONSTRAINT "weighting_polls_result_id_weightings_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weighting_ballots_voter_idx" ON "weighting_ballots" USING btree ("poll_id","voter_hash");--> statement-breakpoint
CREATE INDEX "weighting_ballots_network_idx" ON "weighting_ballots" USING btree ("poll_id","network_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "weighting_polls_one_open" ON "weighting_polls" USING btree ("status") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "weighting_polls_closes_idx" ON "weighting_polls" USING btree ("closes_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weightings_number_idx" ON "weightings" USING btree ("number");--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_weighting_id_weightings_id_fk" FOREIGN KEY ("weighting_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_weighting_id_weightings_id_fk" FOREIGN KEY ("weighting_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_weighting_id_weightings_id_fk" FOREIGN KEY ("weighting_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_weighting_id_weightings_id_fk" FOREIGN KEY ("weighting_id") REFERENCES "public"."weightings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluations_weighting_idx" ON "evaluations" USING btree ("weighting_id");--> statement-breakpoint
CREATE INDEX "published_weighting_idx" ON "published_results" USING btree ("weighting_id");--> statement-breakpoint
-- The local CLI's role (setup-bench-role.ts) reads weightings to link the runs it starts, but can't create or change
-- them, and can't see polls or ballots at all: a poll's salt and its ballots' network hashes stay server-side.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bench_cli') THEN
		REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "weightings" FROM bench_cli;
		REVOKE ALL ON "weighting_polls", "weighting_ballots" FROM bench_cli;
	END IF;
END $$;
