/**
 * Evaluator QA: runs the automated pipeline on projects in the golden set (without editor notes)
 * and measures agreement with the hand labels. Costs real money; run it deliberately.
 *
 *   pnpm eval:golden [--mode quick|standard|deep] [--only aztec,railgun] [--repeat 2]
 *   pnpm eval:golden --rescore <evaluationId,…>   (re-measure finished runs; no model calls)
 *
 * Reports κ overall, on high-scrutiny criteria (high-impact + badge-driving) and per suite; dangerous errors in
 * both directions; answer and coverage rates; score and badge agreement; and, with --repeat, run-to-run stability.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AnswerMap, BADGE_DRIVING, type CriterionDef, criteria, isFavorable, isHighScrutiny, maxPoints, scoreProject, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { importFromSqliteIfNeeded } from "../db/import-sqlite.ts";
import { type DB, openDbFromEnv, schema } from "../db/index.ts";
import { env, REPO_ROOT } from "../env.ts";
import { evalSettings, type Mode, runEvaluation } from "../eval/pipeline.ts";
import { newId } from "../lib/ids.ts";
import { hasApiKey } from "../lib/llm.ts";
import { ensureSeedVersion, upsertProjectFromGolden } from "../services/demo.ts";
import { GOLDEN_DIR, type GoldenFile, loadGoldenFiles } from "../services/golden.ts";
import { runKbBootMaintenance } from "../services/kb-maintenance.ts";
import { answerMapFor, loadEvaluation } from "../services/snapshots.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = (arg("mode") ?? "quick") as Mode;
const only = arg("only")?.split(",");
const repeat = Math.max(1, Math.min(5, Number(arg("repeat") ?? 1)));
const rescore = arg("rescore")?.split(",").filter(Boolean);

type Pair = { criterionId: string; truth: string; pred: string; highImpact: boolean; uncertain: boolean; truthScore: number; predScore: number };

/** Cohen's kappa over categorical labels. */
export function cohensKappa(pairs: { truth: string; pred: string }[]): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  const po = pairs.filter((p) => p.truth === p.pred).length / n;
  const cats = new Set(pairs.flatMap((p) => [p.truth, p.pred]));
  let pe = 0;
  for (const c of cats) pe += (pairs.filter((p) => p.truth === c).length / n) * (pairs.filter((p) => p.pred === c).length / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/**
 * Quadratic-weighted kappa on each answer's score share (option points over the criterion's maximum; unknown
 * scores as the lowest option). Near misses cost little, opposite answers a lot.
 */
export function weightedKappa(pairs: { truthScore: number; predScore: number }[]): number | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const mean = (f: (p: (typeof pairs)[number]) => number) => pairs.reduce((s, p) => s + f(p), 0) / n;
  const observed = mean((p) => (p.truthScore - p.predScore) ** 2);
  const mt = mean((p) => p.truthScore);
  const mp = mean((p) => p.predScore);
  const expected = mean((p) => p.truthScore ** 2) + mean((p) => p.predScore ** 2) - 2 * mt * mp;
  return expected <= 0 ? (observed === 0 ? 1 : 0) : 1 - observed / expected;
}

/** 95% bootstrap interval for a statistic over pairs (seeded, so reruns print the same interval). */
export function bootstrap<T>(pairs: T[], stat: (ps: T[]) => number | null, rounds = 1000): [number, number] | null {
  if (pairs.length < 10) return null;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const vals: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(rand() * pairs.length)]!);
    const v = stat(sample);
    if (v !== null) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return vals.length ? [vals[Math.floor(vals.length * 0.025)]!, vals[Math.floor(vals.length * 0.975)]!] : null;
}

function label(status: string, optionId: string | null) {
  return status === "answered" ? `a:${optionId}` : status;
}

async function main() {
  if (!rescore?.length && !hasApiKey()) {
    console.error("ANTHROPIC_API_KEY is not set; the golden eval runs the real evaluator.");
    process.exit(1);
  }
  // DATABASE_URL, or a PGlite directory (PGLITE_DIR); an empty one is first filled from DB_PATH's SQLite file, so the
  // scratch SQLite databases of earlier rounds still work.
  // Rescoring only reads, so it may point at production (`railway run --service bench-cli`): it never migrates or
  // runs maintenance there.
  const db = rescore?.length ? await openDbFromEnv({ preferPublic: true, migrate: false }) : await openDbFromEnv();
  if (!rescore?.length) {
    await importFromSqliteIfNeeded(db, env.dbPath);
    // The same boot maintenance production runs (interrupted refreshes, legacy knowledge-base rows).
    await runKbBootMaintenance(db);
  }
  // Accuracy is measured against the hand-labelled set only, never the fictional sample.
  const golden = loadGoldenFiles(GOLDEN_DIR);
  if (!golden.length) {
    console.error("The golden set isn't in this checkout: evals/golden is kept out of the public repository.");
    process.exit(1);
  }
  const files = golden.filter((g) => !only || only.includes(g.project.slug));
  if (rescore?.length) {
    const results: { slug: string; evaluationId: string; pairs: Pair[]; agreement: Agreement; run: number }[] = [];
    for (const id of rescore) {
      const b = await loadEvaluation(db, id);
      const g = b && golden.find((x) => x.project.slug === b.project.slug);
      if (!b || !g) {
        console.log(`  ${id}: no evaluation or golden file`);
        continue;
      }
      const run = results.filter((r) => r.slug === g.project.slug).length + 1;
      results.push({ slug: g.project.slug, evaluationId: id, pairs: await compare(db, id, g), agreement: await agreement(db, id, g), run });
    }
    report(results);
    return;
  }
  console.log(`Evaluating ${files.length} project(s) in ${mode} mode…`);
  const results: { slug: string; evaluationId: string; pairs: Pair[]; agreement: Agreement; run: number }[] = [];
  // If this script dies mid-run, its evaluations must not be resumed by a server boot.
  const open = new Set<string>();
  const abandon = async () => {
    for (const id of open)
      await db.update(schema.evaluations).set({ status: "cancelled", error: "Golden eval script exited" }).where(eq(schema.evaluations.id, id));
  };
  process.on("SIGINT", async () => {
    await abandon();
    process.exit(130);
  });
  process.on("exit", abandon);
  for (let run = 1; run <= repeat; run++)
    for (const g of files) {
      const projectId = await upsertProjectFromGolden(db, g);
      const versionId = await ensureSeedVersion(db, projectId, g.project.slug);
      const evaluationId = newId();
      await db.insert(schema.evaluations).values({
        id: evaluationId,
        projectId,
        versionId,
        mode,
        status: "running",
        stage: "scout",
        settings: { ...evalSettings(mode), goldenEval: true } as never,
      });
      console.log(`→ ${g.project.name} (${evaluationId})${repeat > 1 ? ` run ${run}/${repeat}` : ""}`);
      open.add(evaluationId);
      try {
        await runEvaluation(db, evaluationId);
      } catch (e) {
        console.error(`  failed: ${(e as Error).message}`);
        continue;
      } finally {
        open.delete(evaluationId);
      }
      results.push({ slug: g.project.slug, evaluationId, pairs: await compare(db, evaluationId, g), agreement: await agreement(db, evaluationId, g), run });
    }
  report(results);
}

interface Agreement {
  /** Badge-deciding golden labels marked uncertain: badge comparisons that rest on them aren't conclusive. */
  uncertainBadgeInputs: string[];
  truthOverall: number | null;
  predOverall: number | null;
  level: [string | null, string | null];
  tier: [string | null, string | null];
  walkaway: [boolean | null, boolean | null];
  answered: number;
  notResearched: number;
  costUsd: number;
}

/** Score and badge agreement: the numbers and badges a reader actually sees. */
async function agreement(db: DB, evaluationId: string, g: GoldenFile): Promise<Agreement> {
  const rows = await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, evaluationId));
  const truth: AnswerMap = Object.fromEntries(g.answers.map((a) => [a.criterionId, { criterionId: a.criterionId, status: a.status, optionId: a.optionId }]));
  // What would publish: the effective answers with their verifiability multipliers.
  const bundle = await loadEvaluation(db, evaluationId);
  const pred: AnswerMap = bundle
    ? answerMapFor(bundle)
    : Object.fromEntries(rows.map((r) => [r.criterionId, { criterionId: r.criterionId, status: r.status as "answered", optionId: r.optionId }]));
  const t = scoreProject(truth);
  const p = scoreProject(pred);
  const ev = (await db.select({ cost: schema.evaluations.costUsd }).from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  return {
    uncertainBadgeInputs: g.answers.filter((a) => a.labelConfidence === "uncertain" && BADGE_DRIVING.has(a.criterionId)).map((a) => a.criterionId),
    truthOverall: t.overall,
    predOverall: p.overall,
    level: [t.level, p.level],
    tier: [t.trustTier, p.trustTier],
    walkaway: [t.walkaway.passed, p.walkaway.passed],
    answered: rows.filter((r) => r.status === "answered").length,
    notResearched: rows.filter((r) => r.status === "not_researched").length,
    costUsd: ev?.cost ?? 0,
  };
}

async function compare(db: DB, evaluationId: string, g: GoldenFile): Promise<Pair[]> {
  const rows = await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, evaluationId));
  return g.answers
    .map((a) => {
      const r = rows.find((x) => x.criterionId === a.criterionId);
      const c = criteria.find((x) => x.id === a.criterionId) as CriterionDef;
      const share = (status: string | undefined, optionId: string | null | undefined) =>
        status === "answered" ? (c.options.find((o) => o.id === optionId)?.points ?? 0) / (maxPoints(c) || 1) : 0;
      return {
        criterionId: a.criterionId,
        truth: label(a.status, a.optionId),
        pred: r ? label(r.status, r.optionId) : "missing",
        truthScore: share(a.status, a.optionId),
        predScore: share(r?.status, r?.optionId),
        highImpact: isHighScrutiny(c),
        uncertain: a.labelConfidence === "uncertain",
      };
    })
    .filter((p) => !p.uncertain);
}

function report(results: { slug: string; evaluationId: string; pairs: Pair[]; agreement: Agreement; run: number }[]) {
  const all = results.flatMap((r) => r.pairs);
  const hi = all.filter((p) => p.highImpact);
  const exact = (ps: Pair[]) => (ps.length ? ps.filter((p) => p.truth === p.pred).length / ps.length : null);
  const opt = (l: string) => (l.startsWith("a:") ? l.slice(2) : null);
  // Dangerous errors on high-scrutiny criteria, both ways: calling a risky system safe (optimistic), and
  // asserting a risk the truth doesn't have (pessimistic: a false public accusation). Unknowns are neither.
  const optimistic = hi.filter((p) => {
    const c = criteria.find((x) => x.id === p.criterionId)!;
    const t = opt(p.truth);
    const pr = opt(p.pred);
    return pr && isFavorable(c, pr) && !(t && isFavorable(c, t));
  });
  const pessimistic = hi.filter((p) => {
    const c = criteria.find((x) => x.id === p.criterionId)!;
    const t = opt(p.truth);
    const pr = opt(p.pred);
    return t && pr && isFavorable(c, t) && !isFavorable(c, pr);
  });
  // Stability: for projects run more than once, the share of criteria with identical labels across runs.
  const bySlug = new Map<string, Pair[][]>();
  for (const r of results) bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r.pairs]);
  const stability = [...bySlug.entries()]
    .filter(([, runs]) => runs.length > 1)
    .map(([slug, runs]) => {
      const ids = runs[0]!.map((p) => p.criterionId);
      const same = ids.filter((id) => new Set(runs.map((rs) => rs.find((p) => p.criterionId === id)?.pred)).size === 1).length;
      return { slug, identical: ids.length ? same / ids.length : null };
    });
  const out = {
    ranAt: new Date().toISOString(),
    mode,
    projects: results.map((r) => ({
      slug: r.slug,
      run: r.run,
      evaluationId: r.evaluationId,
      exact: exact(r.pairs),
      kappa: cohensKappa(r.pairs),
      ...r.agreement,
    })),
    overall: { n: all.length, exact: exact(all), kappa: cohensKappa(all), kappaCI: bootstrap(all, cohensKappa), weightedKappa: weightedKappa(all) },
    highImpact: { n: hi.length, exact: exact(hi), kappa: cohensKappa(hi), kappaCI: bootstrap(hi, cohensKappa), weightedKappa: weightedKappa(hi) },
    projectsEvaluated: new Set(results.map((r) => r.slug)).size,
    disagreements: all.filter((p) => p.truth !== p.pred).map((p) => ({ criterionId: p.criterionId, truth: p.truth, pred: p.pred, highImpact: p.highImpact })),
    bySuite: suites.map((s) => {
      const ps = all.filter((p) => p.criterionId.startsWith(`${s.id}.`));
      return { suite: s.id, n: ps.length, exact: exact(ps), kappa: cohensKappa(ps) };
    }),
    dangerousErrors: optimistic.map((p) => ({ criterionId: p.criterionId, truth: p.truth, pred: p.pred })),
    falseAccusations: pessimistic.map((p) => ({ criterionId: p.criterionId, truth: p.truth, pred: p.pred })),
    answerRate: all.length ? all.filter((p) => p.pred.startsWith("a:")).length / all.length : null,
    stability,
    targets: { kappaHighImpact: 0.75, kappaOverall: 0.65, dangerousErrors: 0, falseAccusations: 0, stability: 0.9 },
  };
  const dir = resolve(REPO_ROOT, "evals/results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `golden-${out.ranAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  const f = (v: number | null) => (v === null ? "—" : v.toFixed(3));
  const ci = (v: [number, number] | null) => (v ? ` (95% CI ${f(v[0])}–${f(v[1])})` : "");
  console.log(
    `\nOverall   κ ${f(out.overall.kappa)}${ci(out.overall.kappaCI)} · weighted κ ${f(out.overall.weightedKappa)} · exact ${f(out.overall.exact)} · n=${out.overall.n}`,
  );
  console.log(
    `High-imp. κ ${f(out.highImpact.kappa)}${ci(out.highImpact.kappaCI)} · weighted κ ${f(out.highImpact.weightedKappa)} · exact ${f(out.highImpact.exact)} · n=${out.highImpact.n}`,
  );
  for (const s of out.bySuite) console.log(`  ${s.suite.padEnd(18)} κ ${f(s.kappa)} · exact ${f(s.exact)}`);
  console.log(`Dangerous errors (favorable when truth isn't): ${out.dangerousErrors.length}`);
  console.log(`False accusations (unfavorable answer when truth is favorable): ${out.falseAccusations.length}`);
  console.log(`Answer rate: ${f(out.answerRate)}`);
  for (const p of out.projects)
    console.log(
      `  ${p.slug.padEnd(16)} κ ${f(p.kappa)} · overall ${f(p.predOverall)} vs ${f(p.truthOverall)} · level ${p.level[1]} vs ${p.level[0]} · tier ${p.tier[1]} vs ${p.tier[0]} · walkaway ${p.walkaway[1]} vs ${p.walkaway[0]} · $${p.costUsd.toFixed(2)}`,
    );
  for (const p of out.projects)
    if (p.uncertainBadgeInputs.length) console.log(`  ${p.slug}: badge comparison rests on uncertain golden labels (${p.uncertainBadgeInputs.join(", ")})`);
  for (const s of out.stability) console.log(`  stability ${s.slug}: ${f(s.identical)} identical across runs`);
  // PASS needs enough projects and the interval's lower bound at target, not one lucky run.
  const pass =
    out.projectsEvaluated >= 3 &&
    (out.highImpact.kappaCI?.[0] ?? 0) >= 0.75 &&
    (out.overall.kappaCI?.[0] ?? 0) >= 0.65 &&
    out.dangerousErrors.length === 0 &&
    out.falseAccusations.length === 0 &&
    out.stability.every((s) => (s.identical ?? 0) >= 0.9);
  const meetsPoint = (out.highImpact.kappa ?? 0) >= 0.75 && (out.overall.kappa ?? 0) >= 0.65 && !out.dangerousErrors.length && !out.falseAccusations.length;
  console.log(
    pass
      ? "PASS: meets the publishing targets."
      : meetsPoint && out.projectsEvaluated < 3
        ? `ON TARGET for ${out.projectsEvaluated} project(s); PASS needs at least 3 projects with the interval's lower bound at target.`
        : "BELOW TARGET: iterate on prompts or rubric guidance before publishing automated results.",
  );
  console.log(`Saved ${file}`);
}

// Exits when done: the database pool and the extraction workers would otherwise keep the process alive.
if (process.argv[1]?.endsWith("eval-golden.ts"))
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
