CREATE INDEX `evaluations_run_idx` ON `evaluations` (`run_id`);--> statement-breakpoint
CREATE INDEX `evaluations_version_idx` ON `evaluations` (`version_id`);--> statement-breakpoint
CREATE INDEX `evidence_source_idx` ON `evidence` (`source_id`);--> statement-breakpoint
CREATE INDEX `published_active_project_idx` ON `published_results` (`active`,`project_id`);--> statement-breakpoint
CREATE INDEX `published_project_created_idx` ON `published_results` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `published_evaluation_idx` ON `published_results` (`evaluation_id`);--> statement-breakpoint
CREATE INDEX `published_version_idx` ON `published_results` (`version_id`);--> statement-breakpoint
CREATE INDEX `sources_project_kind_idx` ON `sources` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `version_checks_project_ran_idx` ON `version_checks` (`project_id`,`ran_at`);--> statement-breakpoint
-- SEC-5: releases used to copy the whole evaluation settings object, including the pipeline's internal working
-- state (unreviewed scout and code-audit notes, stage progress, knowledge-base stats). Strip it from existing rows;
-- the public API also whitelists release settings at read time.
UPDATE `releases` SET `eval_settings` = json_remove(`eval_settings`, '$.coverageNotes', '$.codeNotes', '$.research', '$.judge', '$.knowledgeBase', '$.goldenEval') WHERE `eval_settings` IS NOT NULL AND json_valid(`eval_settings`);