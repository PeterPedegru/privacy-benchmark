/**
 * Sends one small request of every shape the pipeline uses (agent stages with all tools, judge per suite,
 * summary, release triage) so parameter or schema errors surface in seconds instead of mid-run.
 * Costs well under $1. Usage: pnpm --filter @pb/server preflight
 */
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { criteria, suites } from "@pb/rubric";
import { modelFor } from "../env.ts";
import { runAgent } from "../eval/agent.ts";
import { type JudgeInput, judgeSuite } from "../eval/judge.ts";
import { changeSchema, codeMapSchema, STAGE_TOOLS, summarySchema } from "../eval/pipeline.ts";
import { allToolDefinitions, type ToolContext } from "../eval/tools.ts";
import { addUsage, anthropic, emptyUsage, hasApiKey, modelExtras } from "../lib/llm.ts";
import { classifyRelease } from "../services/versions.ts";

if (!hasApiKey()) {
  console.error("ANTHROPIC_API_KEY is not set (or is a placeholder).");
  process.exit(1);
}

const usage = emptyUsage();
let failed = 0;
async function check(label: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`ok    ${label}  ${note}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}  ${(e as Error).message.slice(0, 400)}`);
  }
}

const ids = criteria.map((c) => c.id);
const defs = allToolDefinitions(ids);

// Agent stages: every tool definition, the model's web-search version, thinking/effort/fallbacks, and the
// tool_result → tool_choice:none path (the budget is zero, so the one tool call is refused).
for (const stage of ["scout", "code", "research", "skeptic"] as const) {
  const stageTools = STAGE_TOOLS[stage];
  await check(`agent  ${stage.padEnd(8)} ${modelFor(stage)}`, async () => {
    const r = await runAgent({
      model: modelFor(stage),
      system: "This is a parameter check. Follow the user's instruction exactly.",
      user: `Call the ${stageTools[1]} tool exactly once with query "test". After its result, reply with the single word OK. Do not search the web.`,
      tools: stageTools.map((n) => defs[n]),
      webSearchUses: 1,
      maxToolCalls: 0,
      effort: "low",
      ctx: {} as ToolContext,
      usage,
      guard: { async check() {} },
    });
    return `${r.toolCalls} tool call(s), stop=${r.stopReason}, text="${r.text.slice(0, 20)}"`;
  });
}

// Judge: the real judge call for every suite (schema, adversary matrix, streaming, output limit), no evidence.
const stubProject = {
  id: "preflight",
  slug: "example",
  name: "Example",
  websiteUrl: "https://example.org",
  tagline: "",
  description: "A parameter check, not a real project.",
  category: "other",
  mechanism: "none",
  attributes: [],
  chains: [],
  githubRepos: [],
} as unknown as JudgeInput["project"];
for (const suite of suites) {
  const model = modelFor("judge");
  await check(`judge  ${suite.id.padEnd(16)} ${model}`, async () => {
    const crit = suite.benchmarks.flatMap((b) => b.criteria);
    const r = await judgeSuite({
      suiteId: suite.id,
      criteria: crit,
      project: stubProject,
      version: null,
      evidence: [],
      sources: new Map(),
      model,
      usage,
      matrixAdversaries: suite.adversaries,
      evaluationDate: new Date().toISOString().slice(0, 10),
    });
    return `${r.answers.length}/${crit.length} answers, ${r.matrix.length} matrix rows`;
  });
}

await check(`summary ${modelFor("summary")}`, async () => {
  const model = modelFor("summary");
  const extras = modelExtras(model, "low");
  const res = await anthropic().beta.messages.parse({
    model,
    max_tokens: 1500,
    system: "Parameter check. Return a one-sentence summary, one power citing criterion custody.pause.pause-fn, and one context value citing evidence id e1.",
    messages: [{ role: "user", content: "Project: Example" }],
    ...(extras.thinking ? { thinking: extras.thinking } : {}),
    output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(summarySchema) },
    ...extras.fallbackParams,
  });
  addUsage(usage, model, res.usage);
  return `stop=${res.stop_reason}, parsed=${!!res.parsed_output}`;
});

for (const [label, stage, schema, prompt] of [
  ["codemap", "codemap", codeMapSchema, "Notes: the Entrypoint is a UUPS proxy owned by a 2-of-4 Safe; upgrades have no timelock. Pools are immutable."],
  [
    "changes",
    "changes",
    changeSchema,
    "Changed answers:\n## custody.pause.pause-fn\nPrevious answer: none. New answer: fast-path. Release notes: added pause().",
  ],
] as const) {
  await check(`${label.padEnd(7)} ${modelFor(stage)}`, async () => {
    const model = modelFor(stage);
    const extras = modelExtras(model, "low");
    const res = await anthropic().beta.messages.parse({
      model,
      max_tokens: 3000,
      system: "Parameter check. Fill the schema from the user's text only.",
      messages: [{ role: "user", content: prompt }],
      ...(extras.thinking ? { thinking: extras.thinking } : {}),
      output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(schema as never) },
      ...extras.fallbackParams,
    });
    addUsage(usage, model, res.usage);
    return `stop=${res.stop_reason}, parsed=${!!res.parsed_output}`;
  });
}

await check(`triage  ${modelFor("versions")}`, async () => {
  const a = await classifyRelease(
    "Example",
    "v1.0.0",
    { tag: "v2.0.0", name: "v2.0.0", body: "Breaking: new proof system. Adds viewing keys.", url: "https://example.org" },
    usage,
  );
  return `isMajor=${a.isMajor}, privacyRelevant=${a.privacyRelevant}`;
});

console.log(`\n${failed ? `${failed} check(s) failed` : "All checks passed"} · cost $${usage.costUsd.toFixed(3)}`);
process.exit(failed ? 1 : 0);
