ALTER TABLE "evaluations" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "evaluations" ADD COLUMN "heartbeat_at" text;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_one_running_per_project" ON "evaluations" USING btree ("project_id") WHERE status = 'running';