/**
 * JSON with object keys in sorted order, at every depth. Postgres's jsonb doesn't keep key order, so anything that
 * hashes or compares JSON read back from the database must use this form.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}
