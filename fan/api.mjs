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
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "X-Fanvue-API-Version": VERSION, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new FanError(res.status, `${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status}`);
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
    /** Every non-creator chat with the custom lists the fan is on. */
    async listAllFans() {
      const chats = await pages("/chats?filter=exclude_creators", 20);
      return chats.map((chat) => ({ uuid: chat.user.uuid, lists: (chat.customLists ?? []).map((l) => l.uuid) }));
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
