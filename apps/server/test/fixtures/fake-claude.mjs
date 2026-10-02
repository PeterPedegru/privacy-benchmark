#!/usr/bin/env node
/**
 * A stand-in for `claude -p` in tests. It records its arguments and environment, then:
 * - with --mcp-config: starts the configured MCP server, lists its tools, calls the tools named in the prompt's
 *   first line ("CALL name name ...") and answers with what they returned;
 * - with --json-schema: answers with the JSON object given on the prompt's first line ("JSON {...}");
 * - with a first line "FAIL <message>": fails the session with that message, as Claude Code reports a usage limit.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = readFileSync(0, "utf8");
// Sessions get an allowlisted environment, so the log goes where TMPDIR points.
writeFileSync(join(process.env.TMPDIR || tmpdir(), "fake-claude-last.json"), JSON.stringify({ args, env: Object.keys(process.env), prompt }));
const done = (o) => {
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, ...o })}\n`,
  );
  process.exit(0);
};
const first = prompt.split("\n")[0];
if (first.startsWith("FAIL ")) {
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: first.slice(5) })}\n`);
  process.exit(1);
}
if (arg("--json-schema")) done({ result: "", structured_output: JSON.parse(first.replace(/^JSON /, "")) });
const cfgPath = arg("--mcp-config");
if (!cfgPath) done({ result: "no tools" });
const server = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.bench;
const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});
let next = 1;
const rpc = (method, params) =>
  new Promise((ok) => {
    const id = next++;
    waiting.set(id, ok);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
const outputs = [];
for (const name of first
  .replace(/^CALL /, "")
  .split(" ")
  .filter(Boolean)) {
  const r = await rpc("tools/call", { name, arguments: {} });
  outputs.push(`${name}:${r.result.isError ? "error" : "ok"}:${r.result.content[0].text.slice(0, 200)}`);
}
child.kill();
done({ result: `tools=${names.join(",")}\n${outputs.join("\n")}` });
