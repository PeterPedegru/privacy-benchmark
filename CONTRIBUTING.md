# Contributing

Thanks for helping. The benchmark's credibility rests on its method being open and checkable, so changes to the method get the same scrutiny as changes to the code.

## Disputing a score

Don't open a pull request to change a project's score. Use **Suggest a correction** on the project's page and cite your sources. Editors decide, and every decision is published in the corrections log.

## Setting up

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # set ADMIN_PASSWORD; ANTHROPIC_API_KEY only to run evaluations
pnpm dev                                        # web on :5173, API on :8787
```

Node and pnpm versions are pinned in `.node-version` and `package.json`.

## Before opening a pull request

Run everything CI runs:

```bash
pnpm test:all   # Biome lint, TypeScript, unit tests (Vitest) and end-to-end tests (Playwright)
```

- Keep pull requests focused, and explain why as well as what.
- Add or update tests for behaviour you change. The evaluation pipeline has a scripted-model test harness (`apps/server/test/pipeline.test.ts`), so pipeline changes can be tested without API calls.
- Never commit secrets, `.env` files or databases.
- `pnpm eval:golden` calls the real models and costs money. Don't run it in CI or on every change.

## Changing the rubric

The rubric (`packages/rubric`) decides every score, so changes are versioned:

1. Edit the criterion, then bump `RUBRIC_VERSION` (minor for clarified guidance, major for changed criteria or weights).
2. List every changed criterion under the new version in `RUBRIC_CHANGES` (`packages/rubric/src/changes.ts`). A test pins each criterion's definition and fails on an unlisted change.
3. Re-pin with `UPDATE_RUBRIC_PINS=1 pnpm --filter @pb/rubric test`, and review any changes to the golden score snapshots.
4. Add the change to the changelog on the methodology page.

Rubric text must stay neutral: no favorable framing, and no evaluated project named (a test checks the names).

## Golden data

`evals/sample/` holds three fictional projects with generated answers (`evals/sample/generate.ts`), so a fresh checkout has a demo release and the browser tests have data. The hand-labelled golden set the evaluator is measured against is kept out of the repository: it quotes private research, and labels anyone can see can be tuned against. When `evals/golden/` exists locally, the demo and `pnpm eval:golden` use it. Check either set with `pnpm exec tsx evals/validate.ts`.

## Database changes

Edit the Drizzle schema in `apps/server/src/db/schema.ts`, then run `pnpm --filter @pb/server db:generate` and commit the generated migration. Migrations run on boot, after a backup.
