// Runs one reply job. The Worker only says which fan and hands over a short-lived Fanvue token; everything else happens here:
// check the reply is still needed, a filter with no tools, then Claude with this fan's tools. Chat text never goes to the Worker.
// Never print the job, the chat or Claude's output: this log is public.
import { createApi } from "./fan/api.mjs";
import { runAgent, runFilter } from "./fan/claude.mjs";
import { answeredSince, isHandedOver, needsReply, newFanMessages, newestPersonal, stillNewest } from "./fan/chat.mjs";
import { startToolServer } from "./fan/mcp.mjs";
import { JobTools, TOOLS } from "./fan/tools.mjs";

const { JOB_ID, WORKER_URL, JOB_SECRET } = process.env;
if (!/^[0-9a-f-]{36}$/.test(JOB_ID ?? "")) throw new Error("bad job id");

const jobUrl = `${WORKER_URL}/job/${JOB_ID}`;
const headers = { "x-job-secret": JOB_SECRET, "Content-Type": "application/json" };

async function post(path, body) {
  const res = await fetch(`${jobUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (path === "") console.log(`result posted: ${res.status}`);
  return res;
}

const jobRes = await fetch(jobUrl, { headers });
if (jobRes.status === 404) {
  console.log("job already finished or expired");
} else {
  if (!jobRes.ok) throw new Error(`fetching the job failed: ${jobRes.status}`);
  const job = await jobRes.json();
  const { fanUuid } = job;
  const api = createApi(job.token);
  try {
    await reply();
  } catch (err) {
    // The status of a Fanvue error is passed on (400 means he cannot be contacted); the message may name the fan, so it stays private.
    await post("", { error: err.message, errorStatus: err.status });
    process.exitCode = 1;
  }

  async function reply() {
    if (isHandedOver(await api.getNotes(fanUuid))) return void (await post("", { done: true, skipped: "handed_over" }));

    const messages = await api.fetchMessages(fanUuid);
    // A tip is thanked unless a person has answered him since; a thank-you is never a follow-up.
    const thanks = !!job.tip && !answeredSince(messages, fanUuid, job.tip.at);
    const followUp = !thanks && !!job.followUpAfter && stillNewest(messages, job.followUpAfter);
    if (!followUp && !thanks && !needsReply(messages, fanUuid)) return void (await post("", { done: true, skipped: "answered" })); // someone answered him by hand

    const verdict = await runFilter({
      ...job.filter,
      prompt: `<fan_messages>\n${newFanMessages(messages, fanUuid) || "(no new messages)"}\n</fan_messages>`,
    });
    if (verdict.verdict === "blocked") {
      console.log("filter: blocked");
      return void (await post("", { blocked: verdict.category }));
    }
    console.log("filter: safe");

    const promptRes = await post("/prompt", { followUp, ...(thanks ? { thanks } : {}) });
    if (!promptRes.ok) throw new Error(`fetching the prompt failed: ${promptRes.status}`);
    const agent = await promptRes.json();

    const tools = new JobTools({
      api,
      fanUuid,
      newestUuid: newestPersonal(messages).uuid,
      followUp,
      thanks,
      sendAt: followUp ? undefined : job.sendAt,
      rules: job.rules,
      usaListUuid: job.usaListUuid,
      gate: async () => {
        try {
          const res = await post("/may-send", {});
          return res.ok ? await res.json() : { ok: false, reason: "Could not check. Stop here." };
        } catch {
          return { ok: false, reason: "Could not check. Stop here." };
        }
      },
    });
    const server = await startToolServer(tools, TOOLS);
    try {
      await runAgent({ ...agent, toolNames: TOOLS.map((t) => t.name), mcpUrl: server.url, mcpKey: server.key });
    } finally {
      server.close();
    }
    await post("", { done: true, followUp, ...tools.report() });
  }
}
