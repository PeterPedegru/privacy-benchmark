import { criteria, findCriterion } from "@pb/rubric";
import { and, eq, like, or } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { type GoldenFile, landscapeText, loadGoldenFiles, type SeedMark, seedMarkOf } from "./golden.ts";
import { verifyQuote } from "./quotes.ts";
import { bumpSnapshots, publishRelease } from "./snapshots.ts";

/** Default repos to watch and the version each demo evaluation is pinned to (see plans/07). */
export const SEED_VERSIONS: Record<string, { repos: string[]; version: string; label: string; releasedAt: string; sourceUrl: string | null; summary: string }> =
  {
    aztec: {
      repos: ["AztecProtocol/aztec-packages"],
      version: "alpha-v5",
      label: "Alpha V5",
      releasedAt: "2026-07-21",
      sourceUrl: "https://aztec.network/blog/introducing-alpha-v5",
      summary: "Faster proving and lower fees; a proving-system vulnerability was disclosed on Aug 7, 2026, with a fix planned for V6.",
    },
    miden: {
      repos: ["0xMiden/node", "0xMiden/miden-vm", "0xMiden/protocol"],
      version: "testnet-v0.16",
      label: "Testnet v0.16",
      releasedAt: "2026-09-14",
      sourceUrl: "https://www.miden.xyz/blog/testnet-v0-16",
      summary: "Billed as the last stop before mainnet; testnet fees and stage-1 privacy with validator re-execution.",
    },
    zama: {
      repos: ["zama-ai/fhevm", "zama-ai/protocol-apps"],
      version: "mainnet",
      label: "Mainnet",
      releasedAt: "2025-12-30",
      sourceUrl: "https://docs.zama.org/protocol/zama-protocol-litepaper",
      summary: "Zama Protocol live on Ethereum with confidential tokens, coprocessors and a threshold KMS.",
    },
    railgun: {
      repos: ["Railgun-Privacy/contract", "Railgun-Privacy/circuits-v2", "Railgun-Community/engine"],
      version: "live-2026-09",
      label: "Live (Sep 2026)",
      releasedAt: "2026-09-30",
      sourceUrl: "https://docs.railgun.org",
      summary: "Railgun as deployed on Ethereum in September 2026, including the July 2026 contract update.",
    },
    "privacy-pools": {
      repos: ["0xbow-io/privacy-pools-core"],
      version: "v1",
      label: "v1",
      releasedAt: "2025-03-31",
      sourceUrl: "https://privacypools.com",
      summary: "Deposit and withdraw with ASP-approved association sets and public ragequit.",
    },
    strk20: {
      repos: ["starkware-libs/starknet-privacy"],
      version: "launch",
      label: "Launch",
      releasedAt: "2026-06-09",
      sourceUrl: "https://www.starknet.io/blog/privacy-live-on-starknet/",
      summary: "STRK20 shielded pool live on Starknet with a mandatory auditor viewing key.",
    },
    ethereum: {
      repos: [],
      version: "fusaka",
      label: "Fusaka",
      releasedAt: "2025-12-03",
      sourceUrl: "https://ethereum.org/roadmap/fusaka",
      summary: "Current Ethereum mainnet fork; no protocol-level privacy features.",
    },
    tempo: {
      repos: ["tempoxyz/tempo", "tempoxyz/zones"],
      version: "t11-zones-testnet",
      label: "Mainnet T11 · Zones testnet",
      releasedAt: "2026-09-07",
      sourceUrl: "https://tempo.xyz/developers/docs/protocol/zones",
      summary: "Tempo L1 at upgrade T11 with Zones on testnet ahead of the first customer deployment.",
    },
  };

export async function ensureSeedVersion(db: DB, projectId: string, slug: string): Promise<string | null> {
  const v = SEED_VERSIONS[slug];
  if (!v) return null;
  const existing = (await db.select().from(schema.projectVersions).where(eq(schema.projectVersions.projectId, projectId))).find((x) => x.version === v.version);
  if (existing) return existing.id;
  const id = newId();
  await db.insert(schema.projectVersions).values({
    id,
    projectId,
    version: v.version,
    label: v.label,
    releasedAt: v.releasedAt,
    source: "manual",
    sourceUrl: v.sourceUrl,
    isMajor: true,
    status: "tracked",
    summary: v.summary,
    privacyRelevant: true,
  });
  return id;
}

export async function upsertProjectFromGolden(db: DB, g: GoldenFile): Promise<string> {
  const p = g.project;
  const existing = (await db.select().from(schema.projects).where(eq(schema.projects.slug, p.slug)))[0];
  const values = {
    slug: p.slug,
    name: p.name,
    websiteUrl: p.website,
    logoUrl: p.logoUrl ?? null,
    tagline: p.tagline ?? "",
    description: p.description ?? "",
    category: p.category ?? "other",
    mechanism: p.mechanism ?? "none",
    attributes: p.attributes ?? [],
    chains: p.chains ?? [],
    l2beatSlug: p.l2beatSlug ?? null,
    defillamaSlug: p.defillamaSlug ?? null,
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    await db.update(schema.projects).set(values).where(eq(schema.projects.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await db.insert(schema.projects).values({ id, ...values, githubRepos: SEED_VERSIONS[p.slug]?.repos ?? [] });
  return id;
}

/**
 * Imports one golden file as a demo evaluation (isDemo). Returns the evaluation id. Never overwrites the class of a
 * row the import didn't seed (R4-12).
 */
export async function importGoldenAsDemo(db: DB, g: GoldenFile, landscape: string | null): Promise<string> {
  const projectId = await upsertProjectFromGolden(db, g);
  const versionId = await ensureSeedVersion(db, projectId, g.project.slug);
  const evaluationId = newId();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(schema.evaluations).values({
      id: evaluationId,
      projectId,
      versionId,
      status: "reviewed",
      stage: "review",
      completedStages: ["intake", "scout", "research", "judge", "verify", "score"],
      mode: "manual",
      summary: g.summary ?? "",
      powers: g.powers ?? [],
      context: g.context ?? {},
      adversaryMatrix: (g.matrix ?? {}) as never,
      reviewedSuites: ["coverage", "trust", "custody", "programmability", "governance", "decentralization", "security"],
      settings: { mode: "manual", evidenceCutoff: g.asOf, notes: "Hand-labelled demo data built from a sourced landscape review." } as never,
      isDemo: true,
      createdAt: now,
      startedAt: now,
      finishedAt: `${g.asOf}T12:00:00.000Z`,
    });

    // Source rows (R4-12): new ones are editor rows marked `meta.seed`, so the seed reclassification can later bring
    // them in line with the classifier. An existing row keeps its class unless the import itself seeded it and no
    // editor has changed it since: a knowledge-base or agent row's class comes from the classifier, and an editor's
    // from the editor. Evidence takes the class its source row ends up with.
    const sourceIdMap = new Map<string, string>();
    const classBySource = new Map<string, string>();
    for (const s of g.sources ?? []) {
      const isLandscape = s.id === "landscape";
      const url = s.url;
      const existing = (
        await tx
          .select()
          .from(schema.sources)
          .where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.url, url)))
      )[0];
      const seed: SeedMark = { golden: g.project.slug, sourceClass: s.sourceClass };
      if (!existing) {
        const id = newId();
        await tx.insert(schema.sources).values({
          id,
          projectId,
          url,
          title: s.title,
          kind: s.kind,
          sourceClass: s.sourceClass,
          date: s.date,
          contentMd: isLandscape && landscape ? landscape : "",
          origin: "admin",
          meta: { seed },
        });
        sourceIdMap.set(s.id, id);
        classBySource.set(s.id, s.sourceClass);
        continue;
      }
      sourceIdMap.set(s.id, existing.id);
      if (seedMarkOf(existing, g.project.slug, s)) {
        await tx
          .update(schema.sources)
          .set({
            title: s.title,
            kind: s.kind,
            sourceClass: s.sourceClass,
            date: s.date,
            contentMd: isLandscape && landscape ? landscape : existing.contentMd,
            meta: { ...(existing.meta ?? {}), seed },
          })
          .where(eq(schema.sources.id, existing.id));
        classBySource.set(s.id, s.sourceClass);
      } else {
        if (!existing.date && s.date) await tx.update(schema.sources).set({ date: s.date }).where(eq(schema.sources.id, existing.id));
        classBySource.set(s.id, existing.sourceClass);
      }
    }

    const answered = new Set<string>();
    for (const a of g.answers ?? []) {
      if (!findCriterion(a.criterionId) || answered.has(a.criterionId)) continue;
      answered.add(a.criterionId);
      const evidenceIds: string[] = [];
      for (const e of a.evidence ?? []) {
        const id = newId();
        let verified = true;
        let method = "author";
        if (e.sourceId === "landscape" && landscape) {
          const chk = verifyQuote(e.quote, landscape);
          verified = chk.verified;
          method = chk.method;
        }
        await tx.insert(schema.evidence).values({
          id,
          evaluationId,
          criterionId: a.criterionId,
          claim: e.claim ?? "",
          quote: e.quote,
          sourceId: sourceIdMap.get(e.sourceId) ?? null,
          url: (g.sources ?? []).find((s) => s.id === e.sourceId)?.url ?? "",
          citedUrl: e.citedUrl ?? null,
          stance: "supports",
          sourceClass: classBySource.get(e.sourceId) ?? "official_docs",
          verified,
          verifyMethod: method,
          createdByStage: "manual",
        });
        evidenceIds.push(id);
      }
      await tx.insert(schema.criterionResults).values({
        id: newId(),
        evaluationId,
        criterionId: a.criterionId,
        status: a.status,
        optionId: a.status === "answered" ? a.optionId : null,
        rationale: a.rationale ?? "",
        confidence: a.confidence ?? "low",
        evidenceIds,
        flags: [],
      });
    }
    // Anything the file skipped is recorded as unknown so the score reflects it.
    for (const c of criteria) {
      if (answered.has(c.id)) continue;
      await tx.insert(schema.criterionResults).values({
        id: newId(),
        evaluationId,
        criterionId: c.id,
        status: "unknown",
        optionId: null,
        rationale: "Not assessed in the demo dataset.",
        confidence: "low",
      });
    }
  });
  return evaluationId;
}

/** Removes every trace of the hand-labelled demo release: demo releases, demo evaluations and never-fetched demo sources. */
export async function purgeDemo(db: DB): Promise<{ releases: number; evaluations: number; sources: number }> {
  // Runs on every boot, so it stays in SQL: loading every source row (with content) first cost seconds and
  // hundreds of MB once knowledge bases grew (EFF-3).
  const out = await db.transaction(async (tx) => {
    const releases = (await tx.delete(schema.releases).where(eq(schema.releases.isDemo, true)).returning({ id: schema.releases.id })).length;
    const evaluations = (await tx.delete(schema.evaluations).where(eq(schema.evaluations.isDemo, true)).returning({ id: schema.evaluations.id })).length;
    // Demo imports created source rows from the golden files; the ones never fetched have no content.
    const sources = (
      await tx
        .delete(schema.sources)
        .where(
          and(
            eq(schema.sources.origin, "admin"),
            eq(schema.sources.contentMd, ""),
            or(eq(schema.sources.kind, "editor_note"), like(schema.sources.url, "%privacy-benchmark.local%")),
          ),
        )
        .returning({ id: schema.sources.id })
    ).length;
    return { releases, evaluations, sources };
  });
  if (out.releases || out.evaluations) bumpSnapshots();
  return out;
}

/** Replaces any previous demo release with a fresh one built from the dataset (the golden set when present, else the sample). */
export async function seedDemo(db: DB): Promise<{ releaseId: string | null; projects: number }> {
  const files = loadGoldenFiles();
  if (!files.length) return { releaseId: null, projects: 0 };
  const landscape = landscapeText();
  const demoReleases = await db.select().from(schema.releases).where(eq(schema.releases.isDemo, true));
  await db.transaction(async (tx) => {
    for (const r of demoReleases) await tx.delete(schema.releases).where(eq(schema.releases.id, r.id));
    await tx.delete(schema.evaluations).where(eq(schema.evaluations.isDemo, true));
  });
  const evaluationIds: string[] = [];
  for (const g of files) evaluationIds.push(await importGoldenAsDemo(db, g, landscape));
  const releaseId = await publishRelease(db, {
    evaluationIds,
    label: "2026.09",
    notes:
      "Demo release, hand-labelled from a sourced landscape review dated Sep 30, 2026. It exists to show how the benchmark works; it is not an official evaluation run.",
    isDemo: true,
    settings: {
      mode: "manual",
      models: {},
      effort: {},
      votesHighImpact: 1,
      votesOther: 1,
      maxToolCalls: {},
      promptHashes: {},
      evidenceCutoff: "2026-09-30",
      notes: "Hand-labelled by editors; no automated evaluation was run for this release.",
    },
  });
  return { releaseId, projects: files.length };
}
