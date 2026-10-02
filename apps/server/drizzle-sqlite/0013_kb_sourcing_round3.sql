-- Project configuration gaps found by the round-3 sourcing review (plans/reviews/round3/sourcing.md, R3-SRC-15).
-- Each update only fills a value that is still empty, so an editor's setting is never overwritten. Every docs root
-- below returned HTTP 200 on 2026-10-01 (docs.aztec.network/developers/docs and /operate are 404 themselves, so the
-- start URLs point at child pages; the prefixes still scope the crawl). The reclassification of rows written before
-- the lane rewrite (R3-SRC-2) needs the classifier, so it runs as a boot task (services/kb-maintenance.ts).

-- Privacy Pools: 0xbow operates the protocol; its blog has the trusted-setup posts, and news often says "0xbow".
UPDATE `projects` SET `extra_domains` = '["0xbow.io"]' WHERE `slug` = 'privacy-pools' AND `extra_domains` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `news_aliases` = '["0xbow"]' WHERE `slug` = 'privacy-pools' AND `news_aliases` = '[]';
--> statement-breakpoint
-- Railgun: three GitBook spaces; the root sitemap only lists /wiki, so /community-faqs (the 0.25% fee page) was never found.
UPDATE `projects` SET `docs_roots` = '[{"url":"https://docs.railgun.org/wiki","prefix":"/wiki"},{"url":"https://docs.railgun.org/developer-guide","prefix":"/developer-guide"},{"url":"https://docs.railgun.org/community-faqs","prefix":"/community-faqs"}]'
 WHERE `slug` = 'railgun' AND `docs_roots` = '[]';
--> statement-breakpoint
-- Tempo: developer docs only; /learn (SEO articles) goes back to the website lane.
UPDATE `projects` SET `docs_roots` = '[{"url":"https://tempo.xyz/developers","prefix":"/developers"}]'
 WHERE `slug` = 'tempo' AND `docs_roots` = '[]';
--> statement-breakpoint
-- Miden: current docs only (no /next or /0.1x copies).
UPDATE `projects` SET `docs_roots` = '[{"url":"https://docs.miden.xyz/reference","prefix":"/reference"},{"url":"https://docs.miden.xyz/builder","prefix":"/builder"}]'
 WHERE `slug` = 'miden' AND `docs_roots` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `news_aliases` = '["Polygon Miden"]' WHERE `slug` = 'miden' AND `news_aliases` = '[]';
--> statement-breakpoint
-- Aztec: leave out the generated aztec-nr API reference.
UPDATE `projects` SET `docs_roots` = '[{"url":"https://docs.aztec.network/developers/docs/foundational-topics","prefix":"/developers/docs"},{"url":"https://docs.aztec.network/participate","prefix":"/participate"},{"url":"https://docs.aztec.network/operate/operators","prefix":"/operate"}]'
 WHERE `slug` = 'aztec' AND `docs_roots` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `news_aliases` = '["Aztec Network","Aztec Labs","zk.money"]' WHERE `slug` = 'aztec' AND `news_aliases` = '[]';
--> statement-breakpoint
-- STRK20: privacy docs, protocol docs, StarkZap privacy and the STRK20 site. (Starknet's own L2BEAT folder is read
-- as the host chain's, from the project's single chain, without configuration.)
UPDATE `projects` SET `docs_roots` = '[{"url":"https://docs.starknet.io/build/starknet-privacy/overview","prefix":"/build/starknet-privacy"},{"url":"https://docs.starknet.io/learn/protocol","prefix":"/learn/protocol"},{"url":"https://docs.starknet.io/build/starkzap/privacy","prefix":"/build/starkzap/privacy"},{"url":"https://strk20.starknet.io/","prefix":""}]'
 WHERE `slug` = 'strk20' AND `docs_roots` = '[]';
--> statement-breakpoint
UPDATE `projects` SET `news_aliases` = '["Starknet privacy"]' WHERE `slug` = 'strk20' AND `news_aliases` = '[]';
--> statement-breakpoint
-- Changed configuration and the new lanes and classes (third_party, interested parties, the pinned lane) mean the
-- knowledge bases must be rebuilt.
UPDATE `projects` SET `kb_refreshed_at` = NULL WHERE `kb_status` = 'ready';
