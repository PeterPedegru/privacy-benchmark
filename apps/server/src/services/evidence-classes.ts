import { eq, sql } from "drizzle-orm";
import { type DB, query, schema } from "../db/index.ts";
import { OFF_CHAIN_POWERS } from "../eval/absence.ts";
import { answerMapFor, loadEvaluation } from "./snapshots.ts";

/**
 * Evidence records the class its source had when it was recorded, and that class weighs the answer. When the
 * knowledge base later reclassifies a source (a news site recognised as third party, a project's own audit copy as
 * its docs), unpublished evaluations must weigh it the new way (R4-8). An answer is flagged only when its weight
 * (verifiability) actually moved (R5-4), and not when it's about to be re-judged anyway (`skipCriteria`). Published
 * snapshots stay frozen. This is the only writer of evidence classes after recording. Returns how many evidence
 * rows changed.
 */
export async function syncEvidenceClasses(db: DB, opts: { evaluationId?: string; flag?: boolean; skipCriteria?: ReadonlySet<string> } = {}): Promise<number> {
  const rows = await query<{ id: string; evaluationId: string; cls: string; demo: boolean }>(
    db,
    sql`SELECT ev.id, ev.evaluation_id AS "evaluationId", s.source_class AS cls, e.is_demo AS demo
       FROM evidence ev
       JOIN sources s ON s.id = ev.source_id
       JOIN evaluations e ON e.id = ev.evaluation_id
       WHERE e.status NOT IN ('published')
         AND ev.source_class <> s.source_class
         AND coalesce(ev.verify_note, '') NOT LIKE 'search attestation%'
         ${opts.evaluationId ? sql`AND ev.evaluation_id = ${opts.evaluationId}` : sql``}`,
  );
  if (!rows.length) return 0;
  // Demo evaluations (hand labels) follow too, but nobody reviews them: no flags.
  const evaluations = [...new Set(rows.filter((r) => !r.demo).map((r) => r.evaluationId))];
  const weight = async (id: string) => {
    const b = await loadEvaluation(db, id);
    return new Map(b ? Object.values(answerMapFor(b)).map((a) => [a.criterionId, a.verifiability]) : []);
  };
  const before = opts.flag === false ? null : new Map(await Promise.all(evaluations.map(async (id) => [id, await weight(id)] as const)));
  await db.transaction(async (tx) => {
    for (const r of rows) await tx.update(schema.evidence).set({ sourceClass: r.cls }).where(eq(schema.evidence.id, r.id));
  });
  if (before) {
    for (const id of evaluations) {
      const was = before.get(id)!;
      for (const [criterionId, now] of await weight(id))
        if (was.get(criterionId) !== now && !opts.skipCriteria?.has(criterionId)) await addResultFlag(db, id, criterionId, "class_changed");
    }
  }
  return rows.length;
}

/**
 * Adds a flag to an unreviewed criterion result, once (atomic: concurrent writers can't duplicate or lose flags).
 * `answeredOnly` limits it to answered results.
 */
export async function addResultFlag(db: DB, evaluationId: string, criterionId: string, flag: string, opts: { answeredOnly?: boolean } = {}) {
  await db.execute(sql`UPDATE criterion_results SET flags = flags || jsonb_build_array(${flag}::text)
    WHERE evaluation_id = ${evaluationId} AND criterion_id = ${criterionId} AND override_status IS NULL
      ${opts.answeredOnly ? sql`AND status = 'answered'` : sql``}
      AND NOT flags ? ${flag}`);
}

/**
 * Search attestations recorded before off-chain powers were excluded (R5-1) can't stand as evidence: an issuer's
 * seizure, screening, operators' keys or trusted hardware aren't in the contracts a search covers. In unpublished
 * evaluations they're marked unverified, and the answers citing them are flagged for review. Idempotent.
 */
export async function invalidateOffchainAttestations(db: DB): Promise<number> {
  const ids = [...OFF_CHAIN_POWERS];
  const rows = await query<{ id: string; evaluationId: string; criterionId: string }>(
    db,
    sql`SELECT ev.id, ev.evaluation_id AS "evaluationId", ev.criterion_id AS "criterionId" FROM evidence ev
       JOIN evaluations e ON e.id = ev.evaluation_id
       WHERE NOT e.is_demo AND e.status <> 'published' AND ev.verify_note = 'search attestation' AND ev.verified
         AND ev.criterion_id IN (${sql.join(
           ids.map((i) => sql`${i}`),
           sql`, `,
         )})`,
  );
  if (!rows.length) return 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .update(schema.evidence)
        .set({ verified: false, verifyNote: "search attestation; not evidence for a power held off-chain" })
        .where(eq(schema.evidence.id, r.id));
      await addResultFlag(tx as unknown as DB, r.evaluationId, r.criterionId, "attestation_offchain", { answeredOnly: true });
    }
  });
  return rows.length;
}
