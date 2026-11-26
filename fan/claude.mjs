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
    return runWithApi(prompt, {
      cwd, model, systemPrompt: system, tools, allowedTools, effort, maxTurns, mcpServers,
      outputFormat: schema && { type: "json_schema", schema },
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
      { cwd, env: { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    // Review, 26 Nov 2026: jobs failed with no visible cause. stderr is read but never printed: only a fixed category is taken from it.
    child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(out);
        if (parsed && typeof parsed === "object") parsed._stderr = category(err);
        resolve(parsed);
      } catch {
        reject(new Error(`claude failed: ${category(err) ?? `exit_${Number(code) || 0}`}`));
      }
    });
    child.stdin.end(prompt);
  });
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
        if (message.subtype === "error_max_structured_output_retries") {
          return { is_error: true, result: "API structured output retries exhausted" };
        }
        return { is_error: message.is_error, structured_output: message.structured_output };
      }
    }
  } catch {
    // The SDK's raw errors can include private request or tool details.
  }
  return { is_error: true, result: "Agent SDK ended without a result" };
}

/** A fixed word for a known Claude failure in a text, or null. The text itself is never passed on: it could quote the chat. */
export function category(text) {
  const t = String(text ?? "");
  if (/usage policy|unable to respond to this request|violat/i.test(t)) return "policy_refusal";
  if (/output token maximum|max_tokens/i.test(t)) return "output_too_long";
  if (/credit balance|billing/i.test(t)) return "billing";
  if (/invalid model|model .*not (found|available)|does not have access/i.test(t)) return "model_unavailable";
  if (/prompt is too long|context (window|length)|too many tokens/i.test(t)) return "prompt_too_long";
  if (/max(imum)? turns/i.test(t)) return "error_max_turns";
  if (/overloaded/i.test(t)) return "overloaded";
  const api = /API Error: (\d{3})/.exec(t)?.[1];
  if (api) return `api_${api}`;
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(t)) return "network";
  return null;
}

function failure(result) {
  // Only known failures are named: other result text could quote the chat.
  // Review, 26 Nov 2026: the CLI's result subtype (e.g. error_max_turns) and an API status code are fixed words, never chat text.
  const subtype = /^error_[a-z_]+$/.test(String(result.subtype ?? "")) ? result.subtype : null;
  const named = subtype ?? category(result.result) ?? result._stderr;
  if (named) return new Error(`claude failed: ${named}`);
  if (/authenticate|limit/i.test(String(result.result ?? ""))) return new Error(`claude failed: ${/authenticate/i.test(result.result) ? "could not authenticate" : "usage limit"}`);
  // Review, 26 Nov 2026: still unnamed. Numbers and fixed words only, never the text: what kind of result, after how many turns, how long.
  if (result.is_error) {
    const sub = /^[a-z_]{1,40}$/.test(String(result.subtype ?? "")) ? result.subtype : "none";
    const turns = Number.isInteger(result.num_turns) ? result.num_turns : -1;
    const len = typeof result.result === "string" ? result.result.length : -1;
    // Only words from this fixed list are named, in the order they appear, so nothing from the chat can leak.
    const KEYS = ["api", "error", "request", "invalid", "timeout", "tool", "mcp", "server", "schema", "json", "structured", "model", "thinking", "budget", "effort", "token", "stream", "aborted", "connection", "refused", "parameter", "temperature", "image", "media", "content", "blocked", "safety", "filter", "permission", "denied", "exceeded", "image_url", "base64", "size", "large", "unsupported", "format", "messages", "role", "empty", "length"];
    const words = String(result.result ?? "").toLowerCase().split(/[^a-z_0-9]+/).filter((w) => KEYS.includes(w));
    const seen = [...new Set(words)].slice(0, 8).join("-") || "nokeys";
    return new Error(`claude failed: unnamed_${sub}_t${turns}_len${len}_${seen}`);
  }
  const known = /authenticate|limit|^API rejected the model or request$|^API structured output retries exhausted$|^Agent SDK ended without a result$/i.test(result.result ?? "") ? result.result.slice(0, 120) : "no usable answer";
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
    // Review, 26 Nov 2026: tool refusals (photo caps, announced photo, sell reminder) each use a turn; at 5 a $0 fan's job ran out
    // before anything was sent and failed every time for 3.5 hours. More room, still bounded.
    maxTurns: /haiku/i.test(model) ? 6 : /sonnet/i.test(model) ? 9 : 12,
  });
  if (result.is_error) throw failure(result);
}
