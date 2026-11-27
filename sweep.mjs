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
    const waiting = new Set(await api.listUnansweredFans());
    // Owner, 15 Nov 2026: also every chat with unread messages or the fan's last word, unless he is on "ignore".
    try {
      for (const chat of await api.listWaitingChats()) if (!(ctx.ignoreListUuid && chat.lists.includes(ctx.ignoreListUuid))) waiting.add(chat.uuid);
    } catch {
      /* the not-answered filter above still covers the usual case */
    }
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
    result.spenders = [...new Set(spenders)]; // no quiet hours for fans who have spent money (owner, 6 Nov 2026)
    result.subscribers = [...new Set(subscribers)]; // owner, 12 Nov 2026: active subscribers are treated highest after VIPs
  } catch (err) {
    result.error ??= `supporters: ${err.status ?? "failed"}`;
  }

  const excluded = new Set(ctx.excluded);
  let allFans = null;
  try {
    allFans = await api.listAllFans();
    // Owner, 7 Nov 2026: nobody on the custom list "ignore" is ever answered; the Worker skips them.
    // Owner, 22 Nov 2026: a new follower or subscriber (chat created in the last 48 hours) needs a fast reaction: no quiet hours for him.
    result.newFans = allFans.filter((f) => f.createdAt && Date.now() - f.createdAt < 48 * 3600_000).map((f) => f.uuid);
    // Owner, 25 Nov 2026: joiners who have not written get one personal opener even if they never come online (the Worker keeps it to once per fan; the runner checks the chat).
    result.joiners = allFans
      .filter((f) => f.createdAt && Date.now() - f.createdAt < 48 * 3600_000 && !f.lastByFan && !excluded.has(f.uuid) && inScope(f.uuid) && !skip.has(f.uuid) && !(ctx.ignoreListUuid && f.lists.includes(ctx.ignoreListUuid)))
      .map((f) => f.uuid);
    if (ctx.usaListUuid) result.english = allFans.filter((f) => f.lists.includes(ctx.usaListUuid)).map((f) => f.uuid); // owner, 15 Nov 2026: English speakers have no quiet hours
    if (ctx.ignoreListUuid) result.ignored = allFans.filter((f) => f.lists.includes(ctx.ignoreListUuid)).map((f) => f.uuid);
    // 16 Nov 2026: these two used to come after the test-list add below; the test list was gone (404 on every sweep), so the
    // add threw first and the ignore and English lists were never refreshed. Report them first, and treat a missing test list as non-fatal.
    const missing = allFans.filter((f) => !f.lists.includes(ctx.testListUuid) && !excluded.has(f.uuid) && inScope(f.uuid)).map((f) => f.uuid);
    result.listed = 0;
    if (missing.length) {
      try {
        await api.addToList(ctx.testListUuid, missing);
        result.listed = missing.length;
      } catch (err) {
        if (err.status !== 404) throw err; // list deleted: nothing to keep in sync
      }
    }
  } catch (err) {
    result.error ??= `list sync: ${err.status ?? "failed"}`;
  }

  // Owner, 28 Nov 2026: everyone who joins through a tracked link is kept in that link's custom list (fv-17).
  try {
    if (allFans) {
      for (const { link, list } of ctx.linkLists ?? []) {
        const onList = new Set(allFans.filter((f) => f.lists.includes(list)).map((f) => f.uuid));
        const missing = (await api.listLinkJoiners(link)).filter((fan) => !onList.has(fan));
        if (missing.length) await api.addToList(list, missing);
      }
    }
  } catch (err) {
    result.error ??= `link list: ${err.status ?? "failed"}`;
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

  // Win-back (owner, 22 Nov 2026): fans whose chat has been silent a long time after her last message. Only ids go to the
  // Worker, which applies the cooldown, daily cap, quiet hours and the runner's own "already nudged" checks.
  try {
    const days = Math.min(Number(ctx.winbackDays) || 0, Number(ctx.winbackGapDays) || Infinity);
    if (days > 0 && allFans) {
      const cutoff = Date.now() - days * 86_400_000;
      result.dormant = allFans
        .filter((f) => f.lastAt && f.lastAt < cutoff && !f.lastByFan && !excluded.has(f.uuid) && inScope(f.uuid) && !skip.has(f.uuid) && !(ctx.ignoreListUuid && f.lists.includes(ctx.ignoreListUuid)))
        .sort((a, b) => b.lastAt - a.lastAt)
        .map((f) => ({ fan: f.uuid, at: f.lastAt }))
        .slice(0, 200);
    }
  } catch (err) {
    result.error ??= `winback: ${err.status ?? "failed"}`;
  }

  const posted = await fetch(`${WORKER_URL}/sweep`, { method: "POST", headers, body: JSON.stringify(result) });
  console.log(`sweep posted: ${posted.status}, ${result.candidates?.length ?? 0} waiting, ${result.listed ?? 0} listed, ${result.online?.length ?? 0} online`);
  }
}
