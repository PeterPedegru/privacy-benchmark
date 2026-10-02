-- X verification now requires the profile to link to the project's domain, and auto-detected handles are
-- re-chosen on every refresh. Rebuild those knowledge bases so posts from the wrong account are removed.
UPDATE `projects` SET `kb_refreshed_at` = NULL WHERE `x_handle_source` = 'auto' OR (`x_handle` IS NOT NULL AND `x_handle_source` IS NULL);
