ALTER TABLE `projects` ADD `x_handle_source` text;--> statement-breakpoint
-- Handles set before this column existed were auto-detected (one was wrong): re-verify them and rebuild those knowledge bases.
UPDATE `projects` SET `x_handle_source` = 'auto', `kb_refreshed_at` = NULL WHERE `x_handle` IS NOT NULL;
