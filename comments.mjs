// Runs one batch of comments: Claude with no tools decides each one, and the Worker checks and publishes.
// Never print the job or Claude's output: they contain comments.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { JOB_ID, IG_WORKER_URL, IG_JOB_SECRET, CLAUDE_CODE_OAUTH_TOKEN, PATH, HOME } = process.env;
if (!/^[0-9a-f-]{36}$/.test(JOB_ID ?? "")) throw new Error("bad job id");

const jobUrl = `${IG_WORKER_URL}/job/${JOB_ID}`;
const headers = { "x-job-secret": IG_JOB_SECRET, "Content-Type": "application/json" };

function runClaude({ model, system, prompt, schema }) {
  return new Promise((resolve, reject) => {
    // An empty folder and a minimal environment, so a comment cannot reach anything else.
    const cwd = mkdtempSync(join(tmpdir(), "comments-"));
    const args = [
      "-p", "--output-format", "json", "--effort", "low", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
      "--model", model, "--tools", "", "--system-prompt", system, "--json-schema", JSON.stringify(schema),
    ];
    const child = spawn("claude", args, { cwd, env: { PATH, HOME, CLAUDE_CODE_OAUTH_TOKEN }, stdio: ["pipe", "pipe", "ignore"] });
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

async function post(body) {
  const res = await fetch(jobUrl, { method: "POST", headers, body: JSON.stringify(body) });
  console.log(`result posted: ${res.status}`);
}

const jobRes = await fetch(jobUrl, { headers });
if (jobRes.status === 404) {
  console.log("job already finished or expired");
} else {
  if (!jobRes.ok) throw new Error(`fetching the job failed: ${jobRes.status}`);
  try {
    const result = await runClaude(await jobRes.json());
    const decisions = result.structured_output?.decisions;
    if (result.is_error || !Array.isArray(decisions)) {
      // Only known failures are named: other result text could quote a comment.
      const known = /authenticate|limit/i.test(result.result ?? "") ? result.result.slice(0, 120) : "no usable answer";
      throw new Error(`claude failed: ${known}`);
    }
    await post({ decisions });
  } catch (err) {
    await post({ error: err.message });
    process.exitCode = 1;
  }
}
