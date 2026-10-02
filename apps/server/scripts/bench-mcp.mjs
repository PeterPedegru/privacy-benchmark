#!/usr/bin/env node
/**
 * MCP server (stdio) that gives a headless Claude Code session the evaluation's tools. It holds no state and no
 * credentials: every call goes to the tool bridge in the `pnpm bench` process that started the session
 * (apps/server/src/eval/claude-code.ts), which runs the pipeline's own tools with that session's context, budget
 * and recording rules.
 *
 *   BENCH_BRIDGE_URL, BENCH_BRIDGE_TOKEN, BENCH_SESSION   set by the bridge in the session's MCP config
 *
 * Speaks newline-delimited JSON-RPC 2.0: initialize, tools/list, tools/call, ping.
 */
import { createInterface } from "node:readline";

const url = process.env.BENCH_BRIDGE_URL;
const token = process.env.BENCH_BRIDGE_TOKEN;
const session = process.env.BENCH_SESSION;
if (!url || !token || !session) {
  process.stderr.write("bench-mcp: BENCH_BRIDGE_URL, BENCH_BRIDGE_TOKEN and BENCH_SESSION are required\n");
  process.exit(1);
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function bridge(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-bench-session": session },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification (initialized, cancelled): nothing to answer
  try {
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bench", version: "1.0.0" },
        },
      });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      const { tools } = await bridge("/tools");
      return send({ id, result: { tools } });
    }
    if (method === "tools/call") {
      const out = await bridge("/call", { name: params?.name, input: params?.arguments ?? {} });
      return send({ id, result: { content: [{ type: "text", text: String(out.text ?? "") }], ...(out.isError ? { isError: true } : {}) } });
    }
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (method === "tools/call") return send({ id, result: { content: [{ type: "text", text: `Tool error: ${e.message}` }], isError: true } });
    return send({ id, error: { code: -32603, message: e.message } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  void handle(msg);
});
rl.on("close", () => process.exit(0));
