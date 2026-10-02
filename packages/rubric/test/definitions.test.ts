import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { criteria, RUBRIC_CHANGES, RUBRIC_VERSION } from "../src";

/**
 * Every criterion's definition is pinned by hash. Changing a question, guidance text or option without bumping
 * the rubric version and listing the criterion in RUBRIC_CHANGES fails here: published answers to the old text
 * would otherwise be compared with new ones as if nothing had changed. After a deliberate change, run
 * `UPDATE_RUBRIC_PINS=1 pnpm --filter @pb/rubric test` to re-pin.
 */
const PIN_FILE = resolve(import.meta.dirname, "criterion-definitions.json");

const hashOf = (c: (typeof criteria)[number]) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        c.question,
        c.guidance,
        c.naAllowed,
        c.highImpact,
        c.options.map((o) => [o.id, o.label, o.points]),
        ...(c.noDataOption ? [c.noDataOption] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 16);

describe("criterion definitions", () => {
  const current = Object.fromEntries(criteria.map((c) => [c.id, hashOf(c)]));
  // Pins are written only on request: a missing file is a failure, not a fresh start.
  if (process.env.UPDATE_RUBRIC_PINS) writeFileSync(PIN_FILE, `${JSON.stringify({ version: RUBRIC_VERSION, hashes: current }, null, 2)}\n`);
  if (!existsSync(PIN_FILE)) throw new Error(`${PIN_FILE} is missing; run with UPDATE_RUBRIC_PINS=1 to create it`);
  const pinned = JSON.parse(readFileSync(PIN_FILE, "utf8")) as { version: string; hashes: Record<string, string> };

  it("changes only with a version bump that lists the changed criteria", () => {
    const changed = Object.keys(current).filter((id) => pinned.hashes[id] && pinned.hashes[id] !== current[id]);
    const addedOrRemoved = [...Object.keys(current), ...Object.keys(pinned.hashes)].filter((id) => !current[id] || !pinned.hashes[id]);
    if (pinned.version === RUBRIC_VERSION) {
      expect(changed, "criterion text changed without a rubric version bump").toEqual([]);
      expect(addedOrRemoved, "criteria added or removed without a rubric version bump").toEqual([]);
      return;
    }
    const listed = new Set(RUBRIC_CHANGES.filter((c) => c.version === RUBRIC_VERSION).flatMap((c) => c.criteria));
    expect(
      changed.filter((id) => !listed.has(id)),
      `changed in ${RUBRIC_VERSION} but missing from RUBRIC_CHANGES`,
    ).toEqual([]);
  });

  it("names a real, unfavorable option as each criterion's no-data answer", () => {
    for (const c of criteria.filter((x) => x.noDataOption)) {
      const o = c.options.find((x) => x.id === c.noDataOption);
      expect(o, c.id).toBeDefined();
      expect(o!.points * 2, c.id).toBeLessThanOrEqual(Math.max(...c.options.map((x) => x.points)));
    }
  });

  it("lists only real criteria", () => {
    for (const c of RUBRIC_CHANGES.flatMap((x) => x.criteria))
      expect(
        criteria.some((x) => x.id === c),
        c,
      ).toBe(true);
  });
});
