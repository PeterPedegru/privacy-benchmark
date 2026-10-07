# NEAR Confidential Intents (FAR): sourced contribution

Manual contributor assessment against rubric **1.3.0**, with evidence cutoff **2026-10-07**, researched with Codex and independently checked in separate research/code-review passes. The benchmark authors' automated Claude evaluator was **not** run. This package proposes a new project; it does not alter another project's scores or the rubric.

## Assessment boundary

The primary reference path is the **embedded Confidential Account on near.com**, including the private FAR host, `intents.far`, mandatory Private PoA Bridge, relay/account services and public backing where required. FAR is the host for its private execution, production, censorship and data-availability criteria. The public NEAR L1's validator count, age, uptime and unrelated NEAR AI/Chain Signatures properties are not assigned to FAR.

The version `documented-2026-10-07` identifies a documentation snapshot, **not** a verified binary release. The importer leaves deployment confirmation unset. Public NEAR account/RPC observations in `sources/security-public-state.json` do not verify the private FAR deployment or its backing.

Foreign-to-foreign confidential swaps (`basic`/`advanced`) are a separate integration route, not proof of every embedded-account guarantee. Supported opt-in confidentiality is credited where appropriate; default-specific criteria examine the reference route's default behavior.

## Result and uncertainty

The unmodified scorer computes **14.395%**, displayed as **14.4%**. Public Privacy Level and Trust Tier remain **unrated** because their deciding facts are incomplete. Walkaway fails on the documented bridge-dependent exit, recovery and authority-held backing path.

| Suite | Score |
| --- | ---: |
| Privacy coverage | 29.575% |
| Privacy trust model | 1.5% |
| Custody & control | 7% |
| Programmability | 15.1% |
| Governance & admin keys | 4.25% |
| Decentralization | 8.6% |
| Security & maturity | 27% |

All **106** criteria were researched: **45 answered, 60 unknown, 1 permitted N/A** (client proving time). Two answered options describe absent published measurements/distribution after logged searches. Unknowns receive the rubric's riskiest points; they do **not** establish adverse facts. The low aggregate is heavily affected by public evidence gaps and should not be described as a verified percentage of NEAR's privacy or as proof of 60 adverse properties.

The normal research-coverage gate counts documented searches as settled research. Its 106/106 result is **research completeness**, not 106 independently verified system properties. Source strength, code-to-deployment correspondence and unresolved facts remain visible in individual answers.

Critical unresolved questions:

- Deployed FAR node/contract/bridge code hashes, enclave measurements and source correspondence.
- Operator visibility, key hierarchy, retention and retrospective disclosure. Plaintext API responses alone do not establish processing outside an enclave.
- Independent producer ownership, voting weights, live privileged roles, upgrade delays, pause and seizure scope.
- Public data/recovery topology and any unilateral exit bypassing the mandatory private bridge.
- Released view-key/disclosure interfaces; May/July announcements describe viewing keys as planned.
- Arbitrary private deployment/composition, sustained private TPS and scoped transfer costs.
- Live-version audit correspondence and the scope of the private components' vulnerability/bounty history.

The dashboard's confidential TVL claim is retained as context: its figures are marked illustrative and the underlying query was not verified. Ordinary Intents volume is not confidential usage. OutLayer's operator/solver visibility description concerns its own integration and is retained as attributed context, not verified near.com topology.

## Package and checks

- `assessment.json`: project/version metadata, all 106 answers, exact quotations, search logs, adversary matrix and concise summary.
- `sources.json` and `sources/`: preserved source text, origin URLs, dates, SHA-256 hashes and evaluated/context classification. Unlinked public code cannot establish deployed FAR behavior.
- `code-check.json`: second code checks with actual files/ref/terms and explicit limits.
- `review.json`: per-answer review decisions/reasons, without overriding the selected answers or multipliers.
- `results.json`: derived output; reproduce it with the scorer rather than treating it as editable input.
- `baseline.json`: immutable release references/hashes for the eight comparison snapshots. Their original evaluations and dates are preserved, not rerun locally.

From the repository root, with its pinned Node/pnpm versions:

```sh
pnpm --filter @pb/server exec tsx src/scripts/contribution.ts check contributions/near-confidential-intents
pnpm --filter @pb/server exec tsx src/scripts/contribution.ts import contributions/near-confidential-intents --local-dir data/near-review
```

`check` runs offline: schema/completeness, source hashes, exact quote verification, supported options/N/A, context boundaries, answer/matrix consistency, original scoring and normal coverage checks. It reports a coverage blocker rather than suppressing it.

`import` requires an explicit **local PGlite directory**, creates a **non-demo manual evaluation in Review**, preserves source contents and ordinary review flags, and never accepts flags, overrides answers, confirms deployment or publishes. It refuses to replace an existing project namespace. No model calls, API keys, transactions or production database writes are involved.

For a local comparison, save the existing project's public response JSON files in an otherwise separate directory and pass `--baseline <directory>` on the initial import into an empty local database. Baseline snapshots must use the current rubric and contain the full criterion set. Their complete snapshots, scores, sources, project-version metadata and dates are copied unchanged, with no fictitious local evaluation history.

After inspecting the imported draft, use the ordinary admin review and release controls. The local preview was accepted with recorded per-answer reasons and published through the existing admin API **without `force`**, after the normal evidence and summary gates. `SEED_DEMO` and the demo importer are not used.

## Upstream publication

An editor must decide whether to accept this manual proposal or use it as research input to a new deep evaluation. Merging the code/package does not publish a project: live evaluations reside in the database. No upstream release is created by this contribution.

The implementation adds an offline/local CLI adapter and tests, with no public API, database-schema, scoring, weight or existing-page changes.
