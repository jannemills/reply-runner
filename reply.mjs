// Runs one reply job. The Worker only says which fan and hands over a short-lived Fanvue token; everything else happens here:
// check the reply is still needed, a filter with no tools, then Claude with this fan's tools. Chat text never goes to the Worker.
// Never print the job, the chat or Claude's output: this log is public.
import { createApi } from "./fan/api.mjs";
import { runAgent, runFilter } from "./fan/claude.mjs";
import { answeredSince, freePhotoSince, herLastTypedAt, isHandedOver, needsReply, newCreatorMessages, newFanMessages, newestPersonal, reactedTo, researchNeedsReply, stillNewest, unansweredRuns } from "./fan/chat.mjs";
import { startToolServer } from "./fan/mcp.mjs";
import { JobTools, RESEARCH_TOOLS, TOOLS } from "./fan/tools.mjs";

const { JOB_ID, WORKER_URL, JOB_SECRET } = process.env;
if (!/^[0-9a-f-]{36}$/.test(JOB_ID ?? "")) throw new Error("bad job id");

// A like or comment on her post gets a message only if she has not written to him in this long (no double texting).
const OWNER_ACTIVE_MS = 8 * 60_000; // the bot keeps out of a chat this long after Andrea typed in it herself (job timeout is 15 min)
const MAX_UNANSWERED_RUNS = 2;      // no follow-up or check-in once she already wrote this many times without an answer

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
    // Chat review, 14 Nov 2026: 185 replies failed in two hours and the log said nothing. Print only a fixed category, never the message.
    const msg = String(err?.message ?? "");
    const kind = /claude failed: .*limit/i.test(msg) ? "claude_usage_limit" : /claude failed: .*authenticate/i.test(msg) ? "claude_login" : msg.startsWith("claude") ? "claude_other" : err?.status ? `fanvue_${err.status}` : "other";
    console.log(`error kind: ${kind}`);
    // The status of a Fanvue error is passed on (400 means he cannot be contacted); the message may name the fan, so it stays private.
    await post("", { error: err.message, errorStatus: err.status });
    process.exitCode = 1;
  }

  // A function declaration, so it exists before reply() runs.
  async function gate() {
    try {
      const res = await post("/may-send", {});
      return res.ok ? await res.json() : { ok: false, reason: "Could not check. Stop here." };
    } catch {
      return { ok: false, reason: "Could not check. Stop here." };
    }
  }

  // A creator we follow, chatted with as a customer (owner, 4 Nov 2026): no follow-ups, tips or reactions, four tools only.
  async function research(messages, wrote) {
    if (!wrote) return void (await post("", { done: true, skipped: "answered" }));
    const verdict = await runFilter({
      ...job.filter,
      prompt: `<fan_messages>\n${newCreatorMessages(messages, fanUuid) || "(no new messages)"}\n</fan_messages>`,
    });
    if (verdict.verdict === "blocked") {
      console.log("filter: blocked");
      return void (await post("", { blocked: verdict.category }));
    }
    console.log("filter: safe");
    const promptRes = await post("/prompt", {});
    if (!promptRes.ok) throw new Error(`fetching the prompt failed: ${promptRes.status}`);
    const agent = await promptRes.json();
    const tools = new JobTools({
      api, fanUuid, newestUuid: newestPersonal(messages)?.uuid, followUp: true, research: true,
      sendAt: job.sendAt, rules: job.rules, usaListUuid: job.usaListUuid, gate,
    });
    const server = await startToolServer(tools, RESEARCH_TOOLS);
    try {
      await runAgent({ ...agent, toolNames: RESEARCH_TOOLS.map((t) => t.name), mcpUrl: server.url, mcpKey: server.key });
    } finally {
      server.close();
    }
    await post("", { done: true, followUp: true, ...tools.report() });
  }

  async function reply() {
    // Owner, 4 Nov 2026: a creator account is never answered as a fan; the Worker re-queues it as a research chat.
    if (!job.research && (await api.isCreator(fanUuid).catch(() => false))) return void (await post("", { done: true, skipped: "creator", creator: true }));
    if (isHandedOver(await api.getNotes(fanUuid))) return void (await post("", { done: true, skipped: "handed_over" }));

    let messages = await api.fetchMessages(fanUuid);
    if (job.research) return research(messages, researchNeedsReply(messages, fanUuid));
    // Chat review, 14 Nov 2026: the bot answered seconds after Andrea typed herself. While she is in the chat, wait until
    // OWNER_ACTIVE_MS has passed since her last own message, then look again (she may have answered him).
    const herAt = herLastTypedAt(messages, fanUuid);
    if (herAt && Date.now() - herAt < OWNER_ACTIVE_MS) {
      await new Promise((r) => setTimeout(r, OWNER_ACTIVE_MS - (Date.now() - herAt)));
      messages = await api.fetchMessages(fanUuid);
      if (Date.now() - herLastTypedAt(messages, fanUuid) < OWNER_ACTIVE_MS) return void (await post("", { done: true, skipped: "answered" }));
    }
    const wrote = needsReply(messages, fanUuid);
    const newest = messages[0];
    const hersNewest = newestPersonal(messages);
    // A tip is thanked unless a person has answered him since; a thank-you is never a follow-up.
    const thanks = !!job.tip && (job.tip.purchase ? !freePhotoSince(messages, fanUuid, job.tip.at) : !answeredSince(messages, fanUuid, job.tip.at));
    // His reaction is answered only when it was to her newest message and he wrote nothing.
    const reaction =
      !wrote && !thanks && job.reaction && hersNewest && hersNewest.sender.uuid !== fanUuid && hersNewest.uuid === job.reaction.messageUuid
        ? reactedTo(hersNewest)
        : null;
    // He liked or commented on her post: one message while he is on her page, if he wrote nothing (then his message is
    // answered instead). Owner, 10 Nov 2026: "the on-like should always trigger", so no 30-minute gap after her own
    // message any more. In a chat where he never wrote, no photo.
    const engaged = !wrote && !thanks && !reaction && job.engagement ? job.engagement.kind : null;
    const hasWritten = messages.some((m) => m.sender.uuid === fanUuid);
    const comment = engaged === "comment" ? await api.postComment(job.engagement.postUuid, job.engagement.commentId, fanUuid).catch(() => null) : null;
    // He came back online: one easy message when her newest message of any kind (mass messages and automations too)
    // has gone unanswered for the quiet time. Owner, 11 Nov 2026 (new fans don't convert): a joiner who never wrote
    // is reached too, after the shorter silentQuietHours, so the welcome automation is not the last he hears from her.
    const quietMs = newest ? Date.now() - Date.parse(newest.sentAt) : 0;
    const quietNeededHours = hasWritten ? job.reengage?.quietHours : job.reengage?.silentQuietHours;
    const reengage =
      !wrote && !thanks && !reaction && !engaged && !!job.reengage && !!newest && newest.sender.uuid !== fanUuid &&
      quietNeededHours > 0 && quietMs >= quietNeededHours * 3600_000;
    const followUp = !thanks && !reaction && !engaged && !reengage && !!job.followUpAfter && stillNewest(messages, job.followUpAfter);
    if (!wrote && !followUp && !thanks && !reaction && !engaged && !reengage) return void (await post("", { done: true, skipped: "answered" })); // someone answered him by hand
    // Chat review, 14 Nov 2026: at most two unanswered messages in a row from her before he writes again (a check-in the owner asked for still goes).
    const ownerAsked = !!job.reengage && job.reengage.quietHours < 0.1;
    if ((followUp || reengage) && !ownerAsked && unansweredRuns(messages, fanUuid) >= MAX_UNANSWERED_RUNS)
      return void (await post("", { done: true, skipped: "answered" }));

    const verdict = await runFilter({
      ...job.filter,
      prompt: `<fan_messages>\n${[newFanMessages(messages, fanUuid), comment && `(comment on her post) ${comment}`].filter(Boolean).join("\n") || "(no new messages)"}\n</fan_messages>`,
    });
    if (verdict.verdict === "blocked") {
      console.log("filter: blocked");
      return void (await post("", { blocked: verdict.category }));
    }
    console.log("filter: safe");

    const promptRes = await post("/prompt", {
      followUp,
      ...(thanks ? { thanks } : {}),
      ...(reaction ? { reaction } : {}),
      ...(engaged ? { engaged } : {}),
      ...(reengage ? { reengageDays: Math.max(1, Math.round(quietMs / 86_400_000)), ...(hasWritten ? {} : { neverWrote: true }) } : {}),
    });
    if (!promptRes.ok) throw new Error(`fetching the prompt failed: ${promptRes.status}`);
    const agent = await promptRes.json();
    // His comment goes to the model here, never through the Worker.
    if (comment) agent.prompt = `${agent.prompt}\n\n<his_comment>\n${comment}\n</his_comment>`;
    // Chat review, 14 Nov 2026: a fan on the English (USA) list got Serbian until he asked "English?".
    if (job.usaListUuid && (await api.fanLists(fanUuid).catch(() => [])).includes(job.usaListUuid))
      agent.prompt = `${agent.prompt}\n\nHe is on your English list: write to him in English, also if earlier messages or automations to him were in Serbian, unless he himself writes to you in another language.`;

    const tools = new JobTools({
      api,
      fanUuid,
      newestUuid: newestPersonal(messages)?.uuid,
      followUp: followUp || reengage || (!!engaged && !hasWritten), // no photos in these
      thanks,
      noSale: !!job.noSale,
      vip: !!job.vip,
      sendAt: followUp ? undefined : job.sendAt,
      rules: job.rules,
      usaListUuid: job.usaListUuid,
      ignoreListUuid: job.ignoreListUuid,
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
    // A message after a quiet spell or on a like or comment earns no follow-up, like a follow-up itself.
    await post("", { done: true, followUp: followUp || reengage || !!engaged, ...tools.report() });
  }
}
