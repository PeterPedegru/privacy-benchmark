import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { modelFor } from "../env.ts";
import { INTAKE_SYSTEM } from "../eval/prompts.ts";
import { exaSearch, hasExa, normalizeHandle } from "../lib/externals.ts";
import { fetchPage } from "../lib/extract.ts";
import { addUsage, anthropic, emptyUsage, hasApiKey, modelExtras, withRetry } from "../lib/llm.ts";

const suggestionSchema = z.object({
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  category: z.enum(["l1", "l2", "privacy_pool", "privacy_app", "coprocessor", "appchain", "wallet", "other"]),
  mechanism: z.enum(["pool", "shielded_ledger", "stealth_address", "confidential_amounts", "private_execution", "none"]),
  attributes: z.array(z.enum(["zk", "fhe", "tee", "mpc", "bridged", "transfers", "defi", "programmable"])),
  chains: z.array(z.string()),
});

export interface IntakeResult {
  url: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  tagline: string;
  description: string;
  category: string;
  mechanism: string;
  attributes: string[];
  chains: string[];
  githubRepos: string[];
  xHandle: string | null;
  docsUrl: string | null;
  links: { docs: string[]; github: string[]; social: string[]; blog: string[]; audits: string[] };
  aiSuggested: boolean;
  costUsd: number;
  /** Set when the site couldn't be read directly, so the fields need a closer look. */
  warning: string | null;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function intake(url: string): Promise<IntakeResult> {
  const page = await fetchPage(url);
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  const blocked = page.status >= 400;
  // Blocked (bot protection) or JavaScript-only pages give the model nothing to read; Exa renders them.
  let pageText = blocked ? "" : page.markdown;
  let warning: string | null = null;
  if (pageText.length < 400) {
    if (hasExa()) {
      try {
        const docs = await exaSearch(`${host} official website`, { includeDomains: [host], numResults: 3, maxCharacters: 6000 });
        const text = docs.map((d) => `# ${d.title}\n${d.text}`).join("\n\n");
        if (text.length > pageText.length) pageText = text;
        if (blocked) warning = `${host} blocked direct access (HTTP ${page.status}), so the details came from Exa. Check them before saving.`;
      } catch {
        // fall through to the warning below
      }
    }
    if (!warning && pageText.length < 400) {
      warning = blocked
        ? `${host} blocked direct access (HTTP ${page.status}). Fill in the details by hand.`
        : `${host} renders its content with JavaScript, so there was little to read. Check the details before saving.`;
    }
  }
  const meta = page.meta;
  const hrefs = meta.links.map((l) => l.href);
  const pick = (re: RegExp) => [...new Set(hrefs.filter((h) => re.test(h)))].slice(0, 8);
  const github = pick(/^https:\/\/github\.com\/[\w.-]+(\/[\w.-]+)?\/?$/);
  const githubRepos = [...new Set(github.map((h) => h.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "")).filter((r) => r.split("/").length === 2))];
  const docs = pick(/docs?\.|\/docs|documentation|gitbook|developers/i);
  const social = pick(/(twitter|x)\.com|discord|t\.me|farcaster|warpcast/i);
  const xHandle =
    social
      .filter((h) => /^https?:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/.test(h) && !/\/(intent|share|home|i)\/?$/.test(h))
      .map((h) => normalizeHandle(h))
      .find(Boolean) ?? null;
  const siteName = (!blocked && (meta.siteName || meta.title.split(/[|–—-]/)[0]?.trim())) || host;
  const base: IntakeResult = {
    url: page.url,
    name: siteName,
    slug: slugify(siteName),
    logoUrl: blocked ? null : meta.icon,
    tagline: meta.description.slice(0, 160),
    description: meta.description,
    category: "other",
    mechanism: "none",
    attributes: [],
    chains: [],
    githubRepos,
    xHandle,
    docsUrl: docs[0] ?? null,
    links: {
      docs,
      github,
      social,
      blog: pick(/blog|medium\.com|mirror\.xyz|substack|paragraph/i),
      audits: pick(/audit/i),
    },
    aiSuggested: false,
    costUsd: 0,
    warning,
  };
  if (!hasApiKey() || pageText.length < 200) return base;
  try {
    const usage = emptyUsage();
    const model = modelFor("intake");
    const extras = modelExtras(model, "low");
    // Interactive (the admin waits on it): retried, but not queued behind long evaluation calls (R5-15).
    const res = await withRetry(() =>
      anthropic().beta.messages.parse({
        model,
        max_tokens: 1500,
        system: INTAKE_SYSTEM,
        messages: [
          {
            role: "user",
            content: `URL: ${page.url}\nTitle: ${meta.title}\nDescription: ${meta.description}\n\nPage text (truncated):\n${pageText.slice(0, 12_000)}\n\nSuggest: name, a neutral tagline (≤ 80 chars), a 2–3 sentence neutral description, category, privacy mechanism, attributes, and chains it runs on.`,
          },
        ],
        ...(extras.thinking ? { thinking: extras.thinking } : {}),
        output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(suggestionSchema) },
        ...extras.fallbackParams,
      }),
    );
    addUsage(usage, model, res.usage);
    const s = res.parsed_output;
    if (s) {
      return { ...base, ...s, slug: slugify(s.name) || base.slug, aiSuggested: true, costUsd: usage.costUsd };
    }
  } catch {
    // metadata-only intake still works
  }
  return base;
}
