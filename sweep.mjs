// The account-wide chores, run every few minutes. No Claude here. The Worker hands over a token and says what it already knows;
// this script reads Fanvue and reports fan ids only: who is waiting for an answer (a missed webhook never leaves anyone
// unanswered), who supports the account, and it keeps the custom list of answered fans complete.
// Never print ids or errors: this log is public.
import { createApi } from "./fan/api.mjs";
import { needsReply, newestPersonal, researchNeedsReply } from "./fan/chat.mjs";

const { WORKER_URL, JOB_SECRET } = process.env;
const headers = { "x-job-secret": JOB_SECRET, "Content-Type": "application/json" };

const res = await fetch(`${WORKER_URL}/sweep`, { headers });
if (res.status === 404) {
  console.log("nothing to sweep");
} else {
  if (!res.ok) throw new Error(`fetching the sweep failed: ${res.status}`);
  const ctx = await res.json();
  const api = createApi(ctx.token);
  const result = {};
  const skip = new Set([...ctx.excluded, ...ctx.skip]);
  const allowed = new Set(ctx.allowed ?? []); // test mode: when set, only these fans are answered and listed
  const inScope = (fan) => !allowed.size || allowed.has(fan);
  const retry = new Set(ctx.retry);

  result.candidates = [];
  // Creators we follow and chat with as a customer (owner, 4 Nov 2026): checked one by one.
  try {
    const found = await api.listCreatorChats().catch(() => new Set());
    result.creators = [...found];
    for (const creator of new Set([...(ctx.research ?? []), ...found])) {
      const messages = await api.fetchMessages(creator);
      if (!researchNeedsReply(messages, creator)) continue;
      const newest = messages[0];
      if (ctx.swept[creator] === newest.uuid && !retry.has(creator)) continue;
      result.candidates.push({ fan: creator, newest: newest.uuid });
    }
  } catch (err) {
    result.error = `research: ${err.status ?? "failed"}`;
  }

  if (ctx.researchOnly) {
    const posted = await fetch(`${WORKER_URL}/sweep`, { method: "POST", headers, body: JSON.stringify(result) });
    console.log(`sweep posted: ${posted.status}, research only, ${result.candidates.length} waiting`);
  } else {
  try {
    const waiting = await api.listUnansweredFans();
    for (const fan of waiting) {
      if (skip.has(fan) || !inScope(fan)) continue;
      const newest = newestPersonal(await api.fetchMessages(fan));
      if (!newest || !needsReply([newest], fan)) continue;
      if (ctx.swept[fan] === newest.uuid && !retry.has(fan)) continue;
      result.candidates.push({ fan, newest: newest.uuid });
    }
  } catch (err) {
    result.error ??= `catch-up: ${err.status ?? "failed"}`;
  }

  try {
    const [spenders, subscribers] = await Promise.all([api.listSpenderFans(), api.listSubscriberFans()]);
    result.supporters = [...new Set([...spenders, ...subscribers])];
  } catch (err) {
    result.error ??= `supporters: ${err.status ?? "failed"}`;
  }

  const excluded = new Set(ctx.excluded);
  let allFans = null;
  try {
    allFans = await api.listAllFans();
    const missing = allFans.filter((f) => !f.lists.includes(ctx.testListUuid) && !excluded.has(f.uuid) && inScope(f.uuid)).map((f) => f.uuid);
    if (missing.length) await api.addToList(ctx.testListUuid, missing);
    result.listed = missing.length;
  } catch (err) {
    result.error ??= `list sync: ${err.status ?? "failed"}`;
  }

  // Who is online now (owner, 4 Nov 2026): the Worker sends a waiting follow-up the moment he comes online and may write
  // to him after a quiet spell. Polled here because presence webhooks may never arrive. Offline is reported only for the
  // fans the Worker watches.
  try {
    const fans = allFans ? allFans.map((f) => f.uuid).filter((f) => !excluded.has(f) && inScope(f)) : [];
    if (fans.length) {
      const { online, offline } = await api.onlineStatuses(fans);
      const watch = new Set(ctx.watch ?? []);
      result.online = online;
      result.offline = offline.filter((f) => watch.has(f));
    }
  } catch (err) {
    result.error ??= `online: ${err.status ?? "failed"}`;
  }

  const posted = await fetch(`${WORKER_URL}/sweep`, { method: "POST", headers, body: JSON.stringify(result) });
  console.log(`sweep posted: ${posted.status}, ${result.candidates?.length ?? 0} waiting, ${result.listed ?? 0} listed, ${result.online?.length ?? 0} online`);
  }
}
