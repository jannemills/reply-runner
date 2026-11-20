// Runs Claude using the selected billing mode and the job's own tools.
// Never print the prompts or Claude's output: they can contain private text.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runClaude({ prompt, model, system, schema, effort = "low", workDir, tools = [], allowedTools = [], maxTurns, mcpServers }) {
  const mode = process.env.FANVUE_CLAUDE_MODE || "subscription";
  const cwd = workDir ?? mkdtempSync(join(tmpdir(), "reply-"));
  if (mode === "api") {
    if (schema) return runApiClassification({ prompt, model, system, schema, effort });
    return runWithApi(prompt, {
      cwd, model, systemPrompt: system, tools, allowedTools, effort, maxTurns, mcpServers,
    });
  }
  if (mode !== "subscription") throw new Error("claude failed: invalid Fanvue processing mode");

  const args = ["--model", model, "--tools", tools.join(","), "--system-prompt", system];
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (mcpServers) {
    const config = join(cwd, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers }), { mode: 0o600 });
    args.push("--mcp-config", config);
  }
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));

  const { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN } = process.env;
  return new Promise((resolve, reject) => {
    // An empty folder and a minimal environment, so nothing else can reach the conversation.
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

export async function runApiClassification({ prompt, model, system, schema, effort = "low", image }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("claude failed: cannot authenticate without API key");
  const content = [{ type: "text", text: prompt }];
  if (image) content.unshift({ type: "image", source: image });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, system, max_tokens: 2048, messages: [{ role: "user", content }],
      output_config: { effort, format: { type: "json_schema", schema } },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    const status = response?.status;
    if (status === 401 || status === 403) throw new Error("claude failed: could not authenticate with the API");
    if (status === 402 || status === 429) throw new Error("claude failed: API rate limit or credit limit");
    if (status === 400) {
      const detail = (await response.json().catch(() => null))?.error?.message ?? "";
      if (/credit balance|insufficient credit|spend limit|billing/i.test(detail)) throw new Error("claude failed: API credit limit");
      if (/output_config\.effort|effort.*support|effort.*extra input/i.test(detail)) throw new Error("claude failed: API rejected the requested effort");
      if (/output_config|json.schema|structured output/i.test(detail)) throw new Error("claude failed: API rejected the structured output format");
    }
    throw new Error(`claude failed: API classification request returned ${status ?? "no response"}`);
  }
  const result = await response.json().catch(() => null);
  const text = result?.content?.find((block) => block.type === "text")?.text;
  if (text && result.stop_reason === "end_turn") {
    try { return { is_error: false, structured_output: JSON.parse(text) }; } catch { /* Invalid verdict fails closed. */ }
  }
  throw new Error("claude failed: API classification returned no structured answer");
}

async function runWithApi(prompt, options) {
  const { PATH, HOME, ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) throw new Error("claude failed: cannot authenticate without API key");
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    for await (const message of query({
      prompt,
      options: {
        ...options,
        env: { PATH, HOME, ANTHROPIC_API_KEY },
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        permissionMode: "dontAsk",
      },
    })) {
      if (message.type === "system" && message.subtype === "init" && message.apiKeySource !== "ANTHROPIC_API_KEY") {
        return { is_error: true, result: "could not authenticate with the configured API key" };
      }
      if (message.type === "assistant" && message.error) {
        if (message.error === "rate_limit" || message.error === "billing_error") {
          return { is_error: true, result: "API rate limit or credit limit" };
        }
        if (message.error === "authentication_failed") {
          return { is_error: true, result: "could not authenticate with the API" };
        }
        if (message.error === "model_not_found" || message.error === "invalid_request") {
          return { is_error: true, result: "API rejected the model or request" };
        }
      }
      if (message.type === "result") {
        return { is_error: message.is_error };
      }
    }
  } catch {
    // The SDK's raw errors can include private request or tool details.
  }
  return { is_error: true, result: "Agent SDK ended without a result" };
}

function failure(result) {
  // Only known failures are named: other result text could quote the chat.
  const known = /authenticate|limit|^API rejected the model or request$|^Agent SDK ended without a result$/i.test(result.result ?? "") ? result.result.slice(0, 120) : "no usable answer";
  return new Error(`claude failed: ${known}`);
}

export async function runFilter({ model, system, prompt, schema }) {
  const result = await runClaude({ model, system, prompt, schema });
  if (result.is_error) throw failure(result);
  const answer = result.structured_output;
  if (answer?.verdict !== "safe" && answer?.verdict !== "blocked") throw failure(result);
  return answer;
}

export async function runAgent({ model, system, prompt, toolNames, mcpUrl, mcpKey }) {
  // Owner, 15 Nov 2026: Sonnet (fans who spent $0) runs at high effort, Opus and Fable (spenders, VIPs) at medium; the filter stays low.
  const effort = /haiku/i.test(model) ? "low" : "medium"; // 17 Nov 2026 (token budget): Sonnet for $0 fans lowered from high to medium; greetings run on Haiku at low
  const result = await runClaude({
    model, system, prompt, effort,
    mcpServers: { chat: { type: "http", url: mcpUrl, headers: { "x-tool-key": mcpKey } } },
    allowedTools: toolNames.map((name) => `mcp__chat__${name}`),
    maxTurns: /haiku/i.test(model) ? 4 : /sonnet/i.test(model) ? 5 : 10,
  });
  if (result.is_error) throw failure(result);
}
