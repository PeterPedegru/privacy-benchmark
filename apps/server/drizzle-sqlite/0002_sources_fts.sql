-- Full-text index over every stored source (docs pages, code files, releases, posts, articles).
CREATE VIRTUAL TABLE IF NOT EXISTS `sources_fts` USING fts5(`title`, `content_md`, content='sources', content_rowid='rowid', tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sources_fts_ai` AFTER INSERT ON `sources` BEGIN
  INSERT INTO `sources_fts`(rowid, `title`, `content_md`) VALUES (new.rowid, new.`title`, new.`content_md`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sources_fts_ad` AFTER DELETE ON `sources` BEGIN
  INSERT INTO `sources_fts`(`sources_fts`, rowid, `title`, `content_md`) VALUES ('delete', old.rowid, old.`title`, old.`content_md`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sources_fts_au` AFTER UPDATE ON `sources` BEGIN
  INSERT INTO `sources_fts`(`sources_fts`, rowid, `title`, `content_md`) VALUES ('delete', old.rowid, old.`title`, old.`content_md`);
  INSERT INTO `sources_fts`(rowid, `title`, `content_md`) VALUES (new.rowid, new.`title`, new.`content_md`);
END;
--> statement-breakpoint
INSERT INTO `sources_fts`(`sources_fts`) VALUES ('rebuild');
