# Privacy Benchmark

Crypto privacy systems, measured on a published rubric. Open source under the [MIT license](LICENSE). Thirty-one benchmarks in seven suites (privacy coverage, trust model, custody & control, programmability, governance, decentralization, security), a percentage for every project on every row, and every number traceable to a published rubric and verbatim, cited evidence.

- **Public site:** benchmark table (best-in-row highlighting, focus column, expandable criteria, "how this number was calculated" drawer), rankings with weighting presets, project pages (score ring, suite rosette, adversary matrix, who holds power, versions), shareable comparison cards, and a full methodology page with published evaluator prompts and downloadable data.
- **Admin dashboard:** add projects by URL, build a searchable knowledge base for each one, track protocol versions (GitHub releases triaged by Claude Sonnet 5.5, or manual), run evaluations judged by Claude Opus 5.5, review flags and override with public reasons, publish immutable releases.

## Quick start

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # set ADMIN_PASSWORD (and ANTHROPIC_API_KEY to run evaluations)
pnpm dev                                        # web on :5173, API on :8787
```

- Locally the database is PGlite (Postgres in WebAssembly) in `data/pglite`, so there's nothing to install. Set `DATABASE_URL` to use a Postgres server instead.
- Open http://localhost:5173. The public site shows only published results from live evaluations. Until the first release, it shows empty states. The hand-labelled demo release is opt-in (`SEED_DEMO=1`); when it's off, any demo data is purged on boot.
- Admin: http://localhost:5173/admin, using `ADMIN_PASSWORD` from `apps/server/.env`.

## How scoring works

The model never picks a percentage. Each benchmark is a set of multiple-choice criteria with anchored, published options (`packages/rubric`). The evaluator answers each criterion from verified quotes, and deterministic code computes:

```
criterion points = option points × verifiability multiplier (after caps)
benchmark %      = Σ points ÷ Σ max points of counted criteria
suite %          = Σ benchmark % × benchmark weight
overall %        = Σ suite % × suite weight
```

Rules and badges:

- Unknown answers score as the riskiest option.
- Favorable answers backed only by marketing are discounted.
- Instant-upgrade powers count as existing powers.
- **Privacy Level** (Z0–Z5), **Trust Tier** (A–D) and the **Walkaway test** are derived from the answers and always shown beside the score.

The full spec is on `/methodology`.

## Evaluations (needs `ANTHROPIC_API_KEY`)

Admin → **Run benchmark** → pick projects, a pinned version for each, and a mode. **Deep** is the default and the mode for published results: evaluations run about weekly, so each one is exhaustive. Quick and standard are cheaper first looks. The pipeline runs these stages:

1. **Ingest:** use the project's knowledge base (below). In production it's built on the editor's machine with `pnpm bench kb` (`KB_BUILD=local`), and an evaluation without a ready one for its version fails, saying what to run. Elsewhere the server builds or refreshes it itself if it's missing, older than `KB_STALE_DAYS`, or pinned to a different version.
2. **Scout:** review the knowledge base, fill gaps (audits, incidents, governance), list deployed contract addresses.
3. **Code audit:** two Opus 5.5 auditors build a model of the system from its code and live onchain state.
   - One maps every privileged function and who can call it: proxy admins and implementations, owners, Safe thresholds, timelock delays, paused state, issuer powers over pooled assets.
   - The other works out how the system runs end to end: each actor and what it can do and see, the transaction lifecycle, ordering and inclusion, forced-inclusion and escape paths with their live parameters, fees, and the reference client's defaults.
4. **Research:** seven parallel agents build on that model, search the knowledge base first, and record verbatim quotes, which are checked against the stored source immediately.
5. **Judge:** Opus 5.5 with structured outputs, majority votes on high-impact criteria.
6. **Code check:** the code is the source of truth. Every answer still unknown or "not disclosed" that code can decide goes back to a code checker (repositories at the pinned version, onchain reads) and is judged again. Track records, usage and audit lists are excluded.
7. **Verify:** a skeptic searches code, onchain state, news and X for counter-evidence; the adversary matrix is checked for consistency.
8. **Score.**

Progress streams live. Results land in **Review**, where you resolve flags and then publish from **Releases**.

### Running evaluations locally

The whole run happens on your machine against the production database: every knowledge-base lane (docs, code, X, news, Exa, L2BEAT, DefiLlama, onchain reads) and every evaluation stage. The result lands in the admin's **Review** like any other; publishing it makes it the project version's live result.

**Claude Code does the reasoning, not the Anthropic API.** Each model step (the scout, both code auditors, the seven research suites, every judge vote, the code check, the skeptic, the code map, change explanations and the summary) runs as a headless Claude Code session (`claude -p`) under your Claude Code login. Sessions start without any API key in their environment, get the pipeline's own system prompts (Claude Code's default prompt, settings, hooks, CLAUDE.md files and other MCP servers are left out), and reach the pipeline's tools through a local MCP server (`scripts/bench-mcp.mjs`) that forwards to a tool bridge in the CLI process: the same tools, budgets, quote checks and recording rules as the API path. Structured steps use `--json-schema`, validated again. The only built-in tool a session may use is web search, where the stage allows it. Install Claude Code and log in once (`claude`); `BENCH_CLAUDE_BIN` points at another install, and `BENCH_CLAUDE_CONCURRENCY` (8) caps the sessions running at once. `--backend api` runs the steps on the Anthropic API instead, which needs `ANTHROPIC_API_KEY` (the `bench-cli` service doesn't have one).

`railway run --service bench-cli` supplies the channel keys (Exa, X, NewsAPI, GitHub) and the database's public URL, and nothing else: the `bench-cli` Railway service holds only the CLI's variables (no admin password or session secret). It connects as the `bench_cli` database role, which can't change the published record and isn't a superuser (`src/scripts/setup-bench-role.ts` creates it), over TLS pinned to the database's own CA (`PGSSL_CA`).

```bash
railway run --service bench-cli -- pnpm bench status [slug]                # versions, knowledge bases, recent evaluations
railway run --service bench-cli -- pnpm bench kb <slug> [--version <tag>]  # rebuild a knowledge base, every lane
railway run --service bench-cli -- pnpm bench run <slug…>|--all [--parallel N] [--mode deep|standard|quick] [--version <tag>]
                                   [--suites a,b] [--skip-kb] [--model <id>|tiered] [--effort low|…|max] [--backend claude-code|api] [--cap <usd>]
railway run --service bench-cli -- pnpm bench resume <evaluationId…>|--failed [--parallel N] [--cap <usd>]  # continue stopped evaluations
railway run --service bench-cli -- pnpm bench rerun <evaluationId> --suites a,b [--cap <usd>]             # research and judge suites again
railway run --service bench-cli -- pnpm bench summarize <evaluationId>                                    # rewrite the summary after overrides
```

- `run` rebuilds the knowledge base first (`--skip-kb` reuses it while it's fresh), then evaluates the latest tracked version, or `--version`. Deep is the default mode.
- Every stage runs on the reasoning model (`MODEL_REASON`, Opus 5.5) at deep mode's xhigh effort; `--model tiered` uses each stage's configured model instead, and `--effort` overrides the effort. An evaluation records its backend, models and effort, so a resume runs the same way.
- Through Claude Code nothing is billed to the API, so there's no spending cap (the CLI reports an API-equivalent cost for reference); a Claude Code usage limit stops the run, and a batch stops starting projects, until it resets or you log in to another account (`resume --failed` then continues). With `--backend api`, a local deep run's cap is `BENCH_DEEP_CAP_USD` ($300), or `--cap`, and the CLI first checks the account can spend.
- Several projects run in one command (`run aztec zama …` or `run --all`, `--parallel N` at a time); `resume --failed` picks up every project's stopped local evaluation. Before anything starts, the CLI checks the model can be reached, and a batch stops starting new projects when it can't.
- `rerun` and `summarize` are the admin's "Re-run suites" and "Regenerate summary", run on this machine through Claude Code: the admin's buttons run on the server, through the API. An override makes the summary stale, which blocks publishing until `summarize` (or the button) writes it again.
- The CLI never migrates the production database. If your checkout and the database disagree, it says whether to deploy or pull first.
- A local run reports a heartbeat every 30 seconds. On a Mac the CLI keeps the machine awake while it runs; if it stops reporting for 3 minutes (closed lid, lost connection), the server marks it failed, never re-queues it, and `pnpm bench resume` continues from the last completed stage. Ctrl-C stops it the same way.
- Without `railway run` the CLI uses the local PGlite database, for trial runs.

- Cost is metered per call. Each evaluation stops at its mode's cap: `EVAL_COST_CAP_USD_QUICK`, `_STANDARD` and `_DEEP` (defaults $10, $25 and $100).
- The agents' GitHub tools use `GITHUB_AGENT_TOKEN` when it's set: a fine-grained, read-only token for public repositories.
- Three model tiers:

  | Tier | Default model | Used for |
  | --- | --- | --- |
  | Gather | Claude Haiku 4.5 | Scouting sources, gathering evidence |
  | Write | Claude Sonnet 5.5 | Release triage and summaries, project summaries, intake metadata |
  | Reason | Claude Opus 5.5 | The code audits and code check, judging criteria (majority votes), the skeptic pass |

  Set them with `MODEL_GATHER`, `MODEL_WRITE` and `MODEL_REASON`. Per-stage `EVAL_MODEL_*` variables override a single stage.
- Each request only sends parameters its model supports: adaptive thinking and effort for Sonnet and Opus, and the right web-search tool version. Sonnet 5.5 and Opus 5.5 requests use the server-side refusal fallback (`fallbacks: "default"`).
- The server verifies the Anthropic key on boot. Admin → Settings shows the exact error if it's rejected; set `ANTHROPIC_WORKSPACE_ID` if your key isn't scoped to a workspace.

## Knowledge base

Each project gets a full-text-searchable knowledge base (Postgres full-text search over overlapping 6,000-character chunks, titles weighted above body text) that every agent searches before browsing. Admin → project → **Knowledge** shows what's in it and lets you run the same search the agents use. In production, knowledge bases are built with `pnpm bench kb` (above), and the admin's refresh button shows that command; elsewhere it builds or refreshes one for a chosen version.

| Section | Source | Needs |
| --- | --- | --- |
| Docs | Full crawl of the docs site (robots.txt and sitemaps respected; docs hosts are probed when the homepage is JavaScript-only) | — |
| Code | The configured repositories at the pinned version's tag, plus the active, relevant repositories of the project's GitHub orgs (every repo is ranked; a shared org only contributes repos naming the project) at their latest release, each prioritized (contracts, circuits, specs, governance, bridges, configs before tests and vendored code) with a repository map | `GITHUB_TOKEN` recommended |
| Changes | Release notes, and the compare diff from the previous tracked version | `GITHUB_TOKEN` recommended |
| Website | Website and blog crawl; Exa renders JavaScript-only sites | Exa for JS-only sites |
| Announcements | The project's own X posts, grouped by quarter (handle detected from the website or set in project settings) | `X_BEARER_TOKEN` |
| News | Crypto press coverage | `NEWSAPI_AI_KEY` |
| Analysis | Independent analyses, audits and incident reports. Recent audits are searched for on their own; at most two reports older than three years are kept | `EXA_API_KEY` |
| Data | L2BEAT and DefiLlama | — |

Placeholder values (`dummy`, `changeme`, …) count as unset, so a missing integration is skipped rather than failing. Limits are set with `KB_MAX_DOCS_PAGES`, `KB_MAX_SITE_PAGES`, `KB_MAX_CODE_FILES` and `KB_MAX_CODE_BYTES`. Onchain reads use public RPCs; set `RPC_URL_<chainId>` for a private one. Published results record what the knowledge base held when the evaluation ran, shown on each project's Sources tab.

## Version tracking

Projects can watch GitHub repos.

- New stable releases are recorded. The newest, and any major bump, go to **Updates** for a decision. Claude Sonnet 5.5 summarizes each one, says whether it's privacy-relevant, and lists the suites it may affect. Releases detected before the key worked are triaged on the next check.
- Projects without useful tags get versions manually. Sonnet 5.5 can summarize an announcement URL.
- Every evaluation is pinned to a version, and GitHub tools read code at that version's tag.
- Visitors can switch versions per project and compare versions side by side (`/benchmarks?p=aztec@alpha-v5,aztec@alpha-v4`).

## Evaluator QA

```bash
pnpm eval:golden --mode quick --only aztec,railgun
```

Runs the real pipeline (editor notes hidden) against the hand labels in `evals/golden/`, which are kept out of the public repository (the maintainers run it). It reports Cohen's κ (with 95% confidence intervals) overall, on high-impact criteria and per suite, plus errors in both directions: favorable answers where the truth is unfavorable, and false accusations. `--rescore <evaluationId>` re-measures a finished run without model calls. Results are saved to `evals/results/`. The golden labels come from the editors' own review, so they're a consistency check, not ground truth.

**Publishing targets:**
- κ ≥ 0.75 on high-impact criteria
- κ ≥ 0.65 overall
- zero dangerous errors

## Repository layout

```
apps/web        Vite + React 19 + TanStack Router/Query + Tailwind v4 + motion (public site + /admin)
apps/server     Hono + Drizzle/Postgres API, evaluation engine, local bench CLI, version tracker, satori card renderer
packages/rubric The rubric as typed data + pure scoring, badges, adversary-matrix checks (single source of truth)
packages/core   Shared API/snapshot types and zod schemas
evals/sample    Fictional sample projects (the demo release and test data) and their generator
evals/golden    The hand-labelled golden set (not in the public repository; gitignored)
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web + API with hot reload |
| `pnpm build && pnpm --filter @pb/server start` | Production build (SPA + esbuild-bundled server in `apps/server/dist`) run with plain node, as on Railway |
| `pnpm test` | Rubric, server and web unit tests |
| `pnpm test:e2e` | Playwright end-to-end tests against a seeded local server |
| `pnpm test:all` | Lint, typecheck, unit and end-to-end tests (what CI runs) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm lint` / `pnpm format` | Biome |
| `SEED_DEMO=1 pnpm seed:demo` | Rebuild the hand-labelled demo release (local design work only) |
| `pnpm exec tsx evals/validate.ts [slug]` | Validate the sample (and, when present, golden) datasets against the rubric |
| `pnpm eval:golden` | Evaluator accuracy run (costs money) |
| `pnpm bench …` | Build knowledge bases and run evaluations locally (above; costs money) |
| `pnpm check:promises` | Fails on an unawaited or misused promise (every query is async) |
| `pnpm --filter @pb/server db:generate` | Generate a migration after editing the Drizzle schema |
| `pnpm --filter @pb/server exec tsx src/scripts/restore-export.ts <file> --target-host <host>` | Restore a logical backup into an empty database (refuses one with data, and any host not named) |

## Deployment

The production site runs on Railway, defined as code in `.railway/railway.ts`: a Postgres service, and the web service with a volume at `/data` for logical backups and the SQLite database the app ran on before Postgres (imported on the first Postgres boot and left as it was). The web service reaches Postgres on the private network (`DATABASE_URL`); the local CLI uses its TCP proxy, through the variables-only `bench-cli` service (the `bench_cli` role, TLS pinned to the database's CA). `railway config plan` previews changes and `railway config apply` applies them. An apply deletes what the file omits, so every live resource and variable is declared (variables as `preserve()` or Railway references, never values).

- Pushes to `main` deploy automatically; Railway doesn't wait for CI (`checkSuites: false`), so run `pnpm test:all` before pushing. Railway gates each deploy on `/api/health`, and the post-deploy smoke workflow (`.github/workflows/smoke.yml`) runs read-only checks against the live site, opening an issue if they fail.
- Several web replicas can share the database: evaluations are claimed with row locks (one running per project), runners report a heartbeat, and boot maintenance and daily backups take advisory locks.
- The server writes a logical backup (every table, gzipped JSON lines) before running migrations and daily, keeping copies on the volume. Railway's volume backups of the Postgres service are the primary copy; enable them in the dashboard.

## Security

- The admin is protected by a single password, hashed with scrypt and compared in constant time, with per-IP and global login rate limits. Sessions use `__Host-` cookies (Secure, SameSite=Strict, HttpOnly) plus a CSRF header. In production the server refuses to start with a weak admin password or session secret.
- Everything agents fetch is treated as untrusted data, never instructions. Their GitHub tools can only read the evaluated project's repositories and auditors' report repositories.
- Analytics: Plausible (no cookies, no personal data) runs on privacybenchmark.org's public pages only. Admin pages never load it and keep the strict policy; a fork's deployment, local development and the tests send nothing (`ANALYTICS_SCRIPT_URL` sets another script, or turns it off when empty).
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Corrections to a published score go through the "Suggest a correction" form on the project's page, where every decision is logged publicly.

## Notes

- `plans/` holds the planning docs and the source research. It's gitignored on purpose.
- `data/` (the local PGlite database and backups), `apps/server/.env` and `evals/golden/` (the private golden set) are gitignored.

## License

[MIT](LICENSE)
