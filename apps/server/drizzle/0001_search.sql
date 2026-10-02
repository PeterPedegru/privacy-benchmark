-- Full-text search over the knowledge base. Each source is split into overlapping chunks, each with a weighted
-- tsvector (title A, content B; 'english' stems like FTS5's porter tokenizer did). Chunking keeps long audits and
-- PDFs under the 1 MB tsvector limit and gives snippets from the passage that matched. As in FTS5's unicode61
-- tokenizer, anything that isn't a letter or digit separates words ("Governance.sol" is "governance" and "sol",
-- "pause_fn" is "pause" "fn"); snippets are taken from the original text.
CREATE TABLE "source_chunks" (
	"source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
	"project_id" text NOT NULL,
	"seq" integer NOT NULL,
	"content" text NOT NULL,
	"tsv" tsvector NOT NULL,
	PRIMARY KEY ("source_id", "seq")
);
--> statement-breakpoint
CREATE INDEX "source_chunks_tsv_idx" ON "source_chunks" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "source_chunks_project_idx" ON "source_chunks" ("project_id");
--> statement-breakpoint
-- Every writer (the app, the local knowledge-base CLI, the SQLite import) indexes the same way: a trigger rebuilds a
-- source's chunks whenever its title, content or project changes. Deletes cascade.
CREATE FUNCTION "pb_index_source"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	chunk_size constant integer := 6000;
	overlap constant integer := 400;
	step constant integer := chunk_size - overlap;
	body text := coalesce(NEW.content_md, '');
	head tsvector := setweight(to_tsvector('english', regexp_replace(left(coalesce(NEW.title, ''), 1000), '[^[:alnum:]]+', ' ', 'g')), 'A');
	n integer;
	i integer := 0;
	part text;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.content_md IS NOT DISTINCT FROM OLD.content_md AND NEW.title IS NOT DISTINCT FROM OLD.title
		AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
		RETURN NEW;
	END IF;
	DELETE FROM source_chunks WHERE source_id = NEW.id;
	n := greatest(1, ceil(greatest(length(body) - overlap, 1)::numeric / step)::integer);
	WHILE i < n LOOP
		part := substr(body, i * step + 1, chunk_size);
		INSERT INTO source_chunks (source_id, project_id, seq, content, tsv)
		VALUES (NEW.id, NEW.project_id, i, part, head || setweight(to_tsvector('english', regexp_replace(part, '[^[:alnum:]]+', ' ', 'g')), 'B'));
		i := i + 1;
	END LOOP;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "sources_index" AFTER INSERT OR UPDATE OF "title", "content_md", "project_id" ON "sources"
	FOR EACH ROW EXECUTE FUNCTION "pb_index_source"();
