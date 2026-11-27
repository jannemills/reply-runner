// The Fanvue API, called with the short-lived token the Worker hands each job. Errors name the call and the status only.
const VERSION = "2025-06-26";
export const PAGE_SIZE = 50;

export class FanError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApi(token, base = process.env.FAN_API_URL || "https://api.fanvue.com") {
  async function call(path, init = {}) {
    // 12 Nov 2026: a backlog of parallel jobs hit Fanvue's rate limit (429) and the replies were lost. Wait and retry,
    // at most ~35 s in all, because a tool call times out after about a minute.
    const started = Date.now();
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "X-Fanvue-API-Version": VERSION, "Content-Type": "application/json" },
      });
      if (res.status !== 429 || attempt >= 4) break;
      const asked = Number(res.headers.get("retry-after"));
      const wait = (asked > 0 ? asked * 1000 : 2000 * 2 ** attempt) + Math.random() * 1500;
      if (Date.now() - started + wait > 35_000) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) {
      // 23 Nov 2026: a 400 on send_reply left a top spender unanswered with no clue why; log Fanvue's own error text (no fan data, 90 chars).
      let why = "";
      if (res.status === 400) {
        const text = String((await res.clone().json().catch(() => ({}))).message ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "id").slice(0, 90);
        if (text) why = ` (${text})`;
      }
      throw new FanError(res.status, `${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status}${why}`);
    }
    return res;
  }

  async function pages(path, maxPages) {
    const items = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const body = await (await call(`${path}${sep}size=${PAGE_SIZE}&page=${page}`)).json();
      items.push(...body.data);
      if (!body.pagination?.hasMore) return items;
    }
    throw new FanError(0, `${path.split("?")[0]} too long to read in full`);
  }

  const fansBy = async (query, maxPages) => new Set((await pages(`/chats?${query}`, maxPages)).map((chat) => chat.user.uuid));

  return {
    /** One media item of a message, with signed URLs (used to look at a fan's photo). */
    async messageMedia(userUuid, messageUuid, mediaUuid) {
      const body = await (await call(`/chats/${userUuid}/messages/${messageUuid}/media?mediaUuids=${mediaUuid}`)).json();
      return body.results?.[mediaUuid] ?? {};
    },
    /** Owner, 4 Nov 2026: every creator account in the chats is a research chat. Uuids only. */
    // The "creators" smart list is not a reliable filter (it returned fans too), so each chat's own isCreator decides.
    // Archived chats are not in the normal list, and many creators sit there (owner, 4 Nov 2026), so both are read.
    async listCreatorChats() {
      const [active, archived] = await Promise.all([pages("/chats?smartListIds=creators", 10), pages("/chats?filter=archived", 10)]);
      return new Set([...active, ...archived].filter((chat) => chat.isCreator === true).map((chat) => chat.user.uuid));
    },
    /** True when the other side of this chat is a creator account. */
    async isCreator(userUuid) {
      const body = await (await call(`/chats?userUuids=${userUuid}&size=1`)).json();
      return !!body.data?.[0]?.isCreator;
    },
    /** The custom lists this fan is on (uuids). */
    async fanLists(userUuid) {
      const body = await (await call(`/chats?userUuids=${userUuid}&size=1`)).json();
      return (body.data?.[0]?.customLists ?? []).map((l) => l.uuid);
    },
    /** One page, newest first. Pass the oldest uuid seen so far to get the page before it. */
    async fetchMessages(fanUuid, before) {
      const anchor = before ? `&beforeMessageUuid=${before}` : "";
      const res = await call(`/chats/${fanUuid}/messages?size=${PAGE_SIZE}&markAsRead=false${anchor}`);
      return (await res.json()).data;
    },
    /**
     * The text of his comment on her post (by comment id, else his newest one there), at most 500 characters, or null.
     * Fanvue's comment shape is read loosely, so a field rename leaves the comment out instead of failing the job.
     */
    async postComment(postUuid, commentId, fanUuid) {
      const body = await (await call(`/posts/${encodeURIComponent(postUuid)}/comments?size=${PAGE_SIZE}&page=1`)).json();
      const comments = Array.isArray(body?.data) ? body.data : [];
      const author = (c) => c?.user?.uuid ?? c?.author?.uuid ?? c?.actor?.uuid ?? c?.fan?.uuid ?? c?.userUuid;
      const found = comments.find((c) => (c?.uuid ?? c?.id) === commentId) ?? comments.find((c) => author(c) === fanUuid);
      const text = found?.text ?? found?.content ?? found?.comment ?? found?.comment_text;
      return typeof text === "string" && text.trim() ? text.trim().slice(0, 500) : null;
    },
    async getNotes(fanUuid) {
      return (await (await call(`/chats/${fanUuid}/notes`)).json()).notes;
    },
    async putNotes(fanUuid, notes) {
      await call(`/chats/${fanUuid}/notes`, { method: "PUT", body: JSON.stringify({ notes }) });
    },
    async markChatUnread(fanUuid) {
      await call(`/chats/${fanUuid}`, { method: "PATCH", body: JSON.stringify({ isRead: false }) });
    },
    /** Shows "typing..." to the fan; best-effort, never throws. */
    async setTyping(fanUuid, isTyping = true) {
      try {
        await call(`/chats/${fanUuid}/typing`, { method: "POST", body: JSON.stringify({ isTyping }) });
      } catch {}
    },
    async sendText(fanUuid, text) {
      await call(`/chats/${fanUuid}/message`, { method: "POST", body: JSON.stringify({ text }) });
    },
    /** One photo, free or with a price in cents (minimum 300). */
    async sendPhoto(fanUuid, text, mediaUuid, priceCents) {
      await call(`/chats/${fanUuid}/message`, {
        method: "POST",
        body: JSON.stringify({ text, mediaUuids: [mediaUuid], ...(priceCents ? { price: priceCents } : {}) }),
      });
    },
    /** Several photos in one paid message (price in cents, minimum 300) with one free preview. */
    async sendPpvPack(fanUuid, text, mediaUuids, previewUuid, priceCents) {
      await call(`/chats/${fanUuid}/message`, {
        method: "POST",
        body: JSON.stringify({ text, mediaUuids, mediaPreviewUuid: previewUuid, price: priceCents }),
      });
    },
    /** Several photos in one free message. */
    async sendPhotos(fanUuid, text, mediaUuids) {
      await call(`/chats/${fanUuid}/message`, { method: "POST", body: JSON.stringify({ text, mediaUuids }) });
    },
    /** One voice note: audio media with no text. Upload it with uploadAudio first and wait until it is ready. */
    async sendVoice(fanUuid, mediaUuid) {
      await call(`/chats/${fanUuid}/message`, { method: "POST", body: JSON.stringify({ mediaUuids: [mediaUuid] }) });
    },
    /**
     * Uploads audio bytes to the vault (needs the write:media scope) and returns the mediaUuid once Fanvue has processed it.
     * Fanvue's multipart upload: open a session, PUT each part to its signed URL, complete, poll until ready.
     */
    async uploadAudio(name, filename, bytes, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 30_000 } = {}) {
      const session = await (await call("/media/uploads", { method: "POST", body: JSON.stringify({ name, filename, mediaType: "audio", sizeBytes: bytes.length }) })).json();
      const total = session.totalParts ?? Math.ceil(bytes.length / session.partSize);
      const signed = await (await call(`/media/uploads/${encodeURIComponent(session.uploadId)}/parts/urls?from=1&to=${total}`)).json();
      const parts = [];
      for (const { partNumber, url } of signed.parts) {
        const start = (partNumber - 1) * session.partSize;
        const put = await fetch(url, { method: "PUT", body: bytes.subarray(start, start + session.partSize) });
        if (!put.ok) throw new FanError(put.status, `PUT upload part failed: ${put.status}`);
        parts.push({ PartNumber: partNumber, ETag: put.headers.get("etag") ?? "" });
      }
      await call(`/media/uploads/${encodeURIComponent(session.uploadId)}`, { method: "PATCH", body: JSON.stringify({ parts }) });
      const started = Date.now();
      for (;;) {
        const media = await (await call(`/media/${session.mediaUuid}`)).json();
        if (media.status === "ready") return session.mediaUuid;
        if (media.status === "error") throw new FanError(0, "audio processing failed");
        if (Date.now() - started > maxWaitMs) throw new FanError(0, "audio not ready in time");
        await sleep(1000);
      }
    },
    /** Everyone credited to this tracking link who subscribed or followed and still has an account (needs read:tracking_links). */
    async listLinkJoiners(linkUuid) {
      const joined = [];
      let cursor = "";
      for (let page = 0; page < 50; page++) {
        const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const body = await (await call(`/tracking-links/${linkUuid}/users?limit=100${after}`)).json();
        for (const u of body.data) if (u.creditedLinkUuid === linkUuid && u.status && u.status !== "deleted") joined.push(u.uuid);
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      return joined;
    },
    async addToList(listUuid, userUuids) {
      for (let i = 0; i < userUuids.length; i += 100) {
        await call(`/chats/lists/custom/${listUuid}/members`, {
          method: "POST",
          body: JSON.stringify({ userUuids: userUuids.slice(i, i + 100) }),
        });
      }
    },
    /** Fans whose chat is marked unanswered. */
    listUnansweredFans: () => fansBy("filter=not_answered&filter=exclude_creators", 10),
    /** Every fan who has spent money, and every subscriber (free trials included). */
    listSpenderFans: () => fansBy("filter=spenders", 10),
    listSubscriberFans: () => fansBy("filter=subscribers", 10),
    /**
     * Chats with unread messages or whose newest message is the fan's, with the lists he is on (owner, 15 Nov 2026: every
     * deploy answers all unread chats unless the fan is on "ignore"). A chat the bot read but did not answer still counts.
     */
    async listWaitingChats() {
      const chats = await pages("/chats?filter=exclude_creators", 20);
      return chats
        .filter((chat) => chat.unreadMessagesCount > 0 || chat.lastMessage?.senderRole === "FAN")
        .map((chat) => ({ uuid: chat.user.uuid, lists: (chat.customLists ?? []).map((l) => l.uuid) }));
    },
    /** Every non-creator chat with the custom lists the fan is on, and when the last message was sent and by whom. */
    async listAllFans() {
      const chats = await pages("/chats?filter=exclude_creators", 20);
      return chats.map((chat) => ({ uuid: chat.user.uuid, lists: (chat.customLists ?? []).map((l) => l.uuid), createdAt: Date.parse(chat.createdAt ?? "") || 0, lastAt: Date.parse(chat.lastMessage?.sentAt ?? "") || 0, lastByFan: chat.lastMessage?.senderRole === "FAN" }));
    },
    /**
     * Who of these fans is online now, 100 per call. Fans who hide their status read as offline with no lastSeenAt, so
     * they are left out of `offline`: a follow-up is never held for someone whose status cannot be seen.
     */
    async onlineStatuses(userUuids) {
      const online = [];
      const offline = [];
      for (let i = 0; i < userUuids.length; i += 100) {
        const body = await (await call("/chats/statuses", { method: "POST", body: JSON.stringify({ userUuids: userUuids.slice(i, i + 100) }) })).json();
        for (const [uuid, status] of Object.entries(body ?? {})) {
          if (status?.isOnline) online.push(uuid);
          else if (status?.lastSeenAt) offline.push(uuid);
        }
      }
      return { online, offline };
    },
    async getFanInsights(fanUuid) {
      return (await call(`/insights/fans/${fanUuid}`)).json();
    },
    listFolders: () => pages("/vault/folders", 4),
    listFolderMedia: (folder) => pages(`/vault/folders/${encodeURIComponent(folder)}/media`, 6),
    /** Media in every post, scheduled and unpublished ones included. */
    async listPostedMedia() {
      const posts = await pages("/posts?includeUnpublished=true", 20);
      return new Set(posts.flatMap((p) => [...(p.mediaUuids ?? []), ...(p.mediaPreviewUuid ? [p.mediaPreviewUuid] : [])]));
    },
    /** Media in mass messages that are still scheduled, so a photo meant as a gift later is never sold now. */
    async listScheduledMassMedia() {
      const mass = await pages("/chats/mass-messages", 10);
      return new Set(mass.filter((m) => m.status === "SCHEDULED").flatMap((m) => m.mediaUuids ?? []));
    },
  };
}
