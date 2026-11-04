// The account-wide chores, run every few minutes. No Claude here. The Worker hands over a token and says what it already knows;
// this script reads Fanvue and reports fan ids only: who is waiting for an answer (a missed webhook never leaves anyone
// unanswered), who supports the account, and it keeps the custom list of answered fans complete.
// Never print ids or errors: this log is public.
import { createApi } from "./fan/api.mjs";
import { needsReply, newestPersonal } from "./fan/chat.mjs";

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
  const retry = new Set(ctx.retry);

  try {
    const waiting = await api.listUnansweredFans();
    result.candidates = [];
    for (const fan of waiting) {
      if (skip.has(fan)) continue;
      const newest = newestPersonal(await api.fetchMessages(fan));
      if (!newest || !needsReply([newest], fan)) continue;
      if (ctx.swept[fan] === newest.uuid && !retry.has(fan)) continue;
      result.candidates.push({ fan, newest: newest.uuid });
    }
  } catch (err) {
    result.error = `catch-up: ${err.status ?? "failed"}`;
  }

  try {
    const [spenders, subscribers] = await Promise.all([api.listSpenderFans(), api.listSubscriberFans()]);
    result.supporters = [...new Set([...spenders, ...subscribers])];
  } catch (err) {
    result.error ??= `supporters: ${err.status ?? "failed"}`;
  }

  try {
    const excluded = new Set(ctx.excluded);
    const missing = (await api.listAllFans()).filter((f) => !f.lists.includes(ctx.testListUuid) && !excluded.has(f.uuid)).map((f) => f.uuid);
    if (missing.length) await api.addToList(ctx.testListUuid, missing);
    result.listed = missing.length;
  } catch (err) {
    result.error ??= `list sync: ${err.status ?? "failed"}`;
  }

  const posted = await fetch(`${WORKER_URL}/sweep`, { method: "POST", headers, body: JSON.stringify(result) });
  console.log(`sweep posted: ${posted.status}, ${result.candidates?.length ?? 0} waiting, ${result.listed ?? 0} listed`);
}
