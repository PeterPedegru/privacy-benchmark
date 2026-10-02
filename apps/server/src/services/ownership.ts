/**
 * The ownership registry for a project, for callers outside a knowledge-base refresh (the evaluation tools).
 *
 *   const cls = classifyUrl(url, "agent", { ...ownershipFor(db, project), title, text, requireRelevance: true });
 *   if (cls.drop) …; else store with cls.kind / cls.sourceClass
 *
 * It combines the registry persisted by the last refresh (`projects.kb_meta.registry`: redirected website host,
 * discovered docs roots, GitHub org blog, X-profile domains, forums) with the project's current configuration, so
 * an editor's change takes effect before the next refresh. The interested parties (every other project in the
 * directory, plus known competitors) come along, so their pages about this project are classed as marketing
 * (R3-JDG-6). No network access.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { schema } from "../db/index.ts";
import type { ClassifyContext, OwnershipRegistry } from "./classify.ts";
import { interestedPartiesFor, type ProjectRow, registryOf } from "./lanes/context.ts";

export { interestedPartiesFor, registryOf } from "./lanes/context.ts";

async function load(db: DB, project: ProjectRow | string): Promise<ProjectRow | undefined> {
  return typeof project === "string" ? (await db.select().from(schema.projects).where(eq(schema.projects.id, project)))[0] : project;
}

export async function ownershipRegistry(db: DB, project: ProjectRow | string): Promise<OwnershipRegistry | null> {
  const p = await load(db, project);
  return p ? registryOf(p) : null;
}

type Ownership = Pick<ClassifyContext, "registry" | "interested">;
/**
 * Per project row: an evaluation's tools share one row object, so its context (which reads every other project) is
 * built once per evaluation, not on every fetch.
 */
const cache = new WeakMap<ProjectRow, Promise<Ownership>>();

async function build(db: DB, project: ProjectRow | string): Promise<Ownership> {
  const p = await load(db, project);
  if (!p) throw new Error("Project not found");
  const registry = registryOf(p);
  return { registry, interested: await interestedPartiesFor(db, p.id, registry) };
}

/** The base classification context for a project (`{ registry, interested }`); spread it into `classifyUrl`'s ctx. */
export async function ownershipFor(db: DB, project: ProjectRow | string): Promise<Ownership> {
  if (typeof project === "string") return build(db, project);
  let hit = cache.get(project);
  if (!hit) {
    hit = build(db, project);
    cache.set(project, hit);
    hit.catch(() => cache.delete(project));
  }
  return hit;
}
