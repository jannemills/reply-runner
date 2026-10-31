// Runs one job: a filter with no tools, then an agent that may use only the job's own tools.
// Never print the job or Claude's output: they can contain private text.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { JOB_ID, WORKER_URL, JOB_SECRET, CLAUDE_CODE_OAUTH_TOKEN, PATH, HOME } = process.env;
if (!/^[0-9a-f-]{36}$/.test(JOB_ID ?? "")) throw new Error("bad job id");

const jobUrl = `${WORKER_URL}/job/${JOB_ID}`;
const headers = { "x-job-secret": JOB_SECRET, "Content-Type": "application/json" };

function runClaude(prompt, args) {
  return new Promise((resolve, reject) => {
    // An empty folder and a minimal environment, so nothing else can reach the conversation.
    const cwd = mkdtempSync(join(tmpdir(), "reply-"));
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--effort", "low", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", ...args],
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

async function runFilter({ model, system, prompt, schema }) {
  const result = await runClaude(prompt, ["--model", model, "--tools", "", "--system-prompt", system, "--json-schema", JSON.stringify(schema)]);
  if (result.is_error) throw failure(result);
  const answer = result.structured_output;
  if (answer?.verdict !== "safe" && answer?.verdict !== "blocked") throw failure(result);
  return answer;
}

async function runAgent({ model, system, prompt, tools }) {
  const config = join(mkdtempSync(join(tmpdir(), "mcp-")), "mcp.json");
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: { chat: { type: "http", url: `${jobUrl}/mcp`, headers: { "x-job-secret": JOB_SECRET } } } }),
    { mode: 0o600 },
  );
  const result = await runClaude(prompt, [
    "--model", model,
    "--tools", "",
    "--mcp-config", config,
    "--allowedTools", tools.map((t) => `mcp__chat__${t}`).join(","),
    "--max-turns", "10",
    "--system-prompt", system,
  ]);
  if (result.is_error) throw failure(result);
}

async function post(body) {
  const res = await fetch(jobUrl, { method: "POST", headers, body: JSON.stringify(body) });
  console.log(`result posted: ${res.status}`);
}

const jobRes = await fetch(jobUrl, { headers });
if (jobRes.status === 404) {
  console.log("job already finished or expired");
} else {
  if (!jobRes.ok) throw new Error(`fetching the job failed: ${jobRes.status}`);
  const job = await jobRes.json();
  try {
    const verdict = await runFilter(job.filter);
    if (verdict.verdict === "blocked") {
      console.log("filter: blocked");
      await post({ blocked: verdict.category });
    } else {
      console.log("filter: safe");
      await runAgent(job.agent);
      await post({ done: true });
    }
  } catch (err) {
    await post({ error: err.message });
    process.exitCode = 1;
  }
}
