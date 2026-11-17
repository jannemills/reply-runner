// Runs the Claude CLI: a filter with no tools, then an agent that may use only the job's own tools.
// Never print the prompts or Claude's output: they can contain private text.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runClaude(prompt, args, effort = "low") {
  const { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN } = process.env;
  return new Promise((resolve, reject) => {
    // An empty folder and a minimal environment, so nothing else can reach the conversation.
    const cwd = mkdtempSync(join(tmpdir(), "reply-"));
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--effort", effort, "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", ...args],
      { cwd, env: { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN }, stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude exited with code ${code} and no JSON result`));
      }
    });
    child.stdin.end(prompt);
  });
}

function failure(result) {
  // Only known failures are named: other result text could quote the chat.
  const known = /authenticate|limit/i.test(result.result ?? "") ? result.result.slice(0, 120) : "no usable answer";
  return new Error(`claude failed: ${known}`);
}

export async function runFilter({ model, system, prompt, schema }) {
  const result = await runClaude(prompt, ["--model", model, "--tools", "", "--system-prompt", system, "--json-schema", JSON.stringify(schema)]);
  if (result.is_error) throw failure(result);
  const answer = result.structured_output;
  if (answer?.verdict !== "safe" && answer?.verdict !== "blocked") throw failure(result);
  return answer;
}

export async function runAgent({ model, system, prompt, toolNames, mcpUrl, mcpKey }) {
  const config = join(mkdtempSync(join(tmpdir(), "mcp-")), "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { chat: { type: "http", url: mcpUrl, headers: { "x-tool-key": mcpKey } } } }), { mode: 0o600 });
  // Owner, 15 Nov 2026: Sonnet (fans who spent $0) runs at high effort, Opus and Fable (spenders, VIPs) at medium; the filter stays low.
  const effort = /haiku/i.test(model) ? "low" : "medium"; // 17 Nov 2026 (token budget): Sonnet for $0 fans lowered from high to medium; greetings run on Haiku at low
  const result = await runClaude(prompt, [
    "--model", model,
    "--tools", "",
    "--mcp-config", config,
    "--allowedTools", toolNames.map((t) => `mcp__chat__${t}`).join(","),
    "--max-turns", /haiku/i.test(model) ? "4" : /sonnet/i.test(model) ? "5" : "10",
    "--system-prompt", system,
  ], effort);
  if (result.is_error) throw failure(result);
}
