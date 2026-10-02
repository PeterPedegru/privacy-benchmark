-- Project configuration found wrong or missing by the sourcing review (plans/reviews/04-sourcing.md). Each update
-- only fills an empty value or replaces a value known to be wrong, so editor changes are never overwritten.
UPDATE `projects` SET `github_repos` = '["tempoxyz/tempo","tempoxyz/zones"]' WHERE `slug` = 'tempo' AND `github_repos` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `github_repos` = '["starkware-libs/starknet-privacy"]' WHERE `slug` = 'strk20' AND `github_repos` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `l2beat_slug` = 'zama-cw' WHERE `slug` = 'zama' AND (`l2beat_slug` IS NULL OR `l2beat_slug` = 'zama-confidential-tokens');
--> statement-breakpoint
UPDATE `projects` SET `github_repos` = '["zama-ai/fhevm","zama-ai/protocol-apps"]' WHERE `slug` = 'zama' AND `github_repos` = '["zama-ai/fhevm"]';
--> statement-breakpoint
UPDATE `projects` SET `github_repos` = '["Railgun-Privacy/contract","Railgun-Privacy/circuits-v2","Railgun-Community/engine"]' WHERE `slug` = 'railgun' AND `github_repos` = '["Railgun-Privacy/contract"]';
--> statement-breakpoint
UPDATE `projects` SET `github_repos` = '["0xMiden/node","0xMiden/miden-vm","0xMiden/protocol"]' WHERE `slug` = 'miden' AND `github_repos` = '["0xMiden/node"]';
--> statement-breakpoint
UPDATE `projects` SET `x_handle` = 'RAILGUN_Project', `x_handle_source` = 'admin' WHERE `slug` = 'railgun' AND `x_handle` IS NULL;
--> statement-breakpoint
UPDATE `projects` SET `x_handle` = '0xprivacypools', `x_handle_source` = 'admin' WHERE `slug` = 'privacy-pools' AND `x_handle` IS NULL;
--> statement-breakpoint
-- Changed configuration means the knowledge bases must be rebuilt.
UPDATE `projects` SET `kb_refreshed_at` = NULL WHERE `slug` IN ('tempo', 'strk20', 'zama', 'railgun', 'miden', 'privacy-pools');
