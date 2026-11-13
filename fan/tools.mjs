// The reply agent's tools. One JobTools object serves one job: the fan is fixed when it is built and no tool takes a fan id.
import {
  belgradeNow,
  finalText,
  formatChat,
  formatResearchChat,
  isHandedOver,
  mergeNotes,
  newFanMessages,
  newestPersonal,
  splitNotes,
  splitReply,
  stillNewest,
  typingDelayMs,
  usedMomentSets,
  withReplyCount,
  withStopLine,
  withUsedMomentSet,
} from "./chat.mjs";
import { buildPool, poolForFan, isFirstBuyer, notBuyingRefusal, paidCandidates, photoRefusal, pickPack, pickPhoto, profileText, salesHistory } from "./sales.mjs";

const none = { type: "object", properties: {}, additionalProperties: false };

export const TOOLS = [
  {
    name: "read_chat",
    description: "Read this fan's latest messages, oldest first.",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1, maximum: 200, description: "How many messages. Default 30." } },
      additionalProperties: false,
    },
  },
  { name: "read_memory", description: "Read your saved notes about this fan.", inputSchema: none },
  {
    name: "save_memory",
    description: "Replace your saved notes about this fan.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "send_reply",
    description: "Send your reply to this fan. Works once. Each line goes out as its own message, at most three. It may be refused; the result says why.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "hand_over",
    description: "Send nothing, stop the bot for this chat and leave it unread so a person replies. Only for the hand_over cases in your rules.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", enum: ["complaint", "payment", "business", "other"] } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "read_fan_profile",
    description: "Read what he has spent, his subscription, the photos he already got in this chat and the price guide. Numbers only.",
    inputSchema: none,
  },
  {
    name: "send_photo",
    description:
      "Send him one photo with a one-line caption, after your text reply if you send one. The photo is picked for you, unseen by him. kind free, or kind paid with price_usd. It may be refused; the result says why.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["free", "paid"] },
        text: { type: "string", description: "One short line that says nothing about what is in the photo." },
        price_usd: { type: "integer", minimum: 3, maximum: 20, description: "Only for kind paid." },
        nude: { type: "boolean", description: "True only if the chat already promised him a nude." },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_ppv_pack",
    description:
      "Send him several paid photos in ONE message (2 to 6), with one extra photo shown to him free as the preview. All picked for you, unseen by him. Same limits as a paid send_photo (it counts as your photo for this reply). Price the whole pack: more photos, a higher price. It may be refused; the result says why.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 2, maximum: 6, description: "Paid photos in the pack, not counting the free preview." },
        text: { type: "string", description: "One short line that says nothing about what is in the photos." },
        price_usd: { type: "integer", minimum: 5, maximum: 40, description: "Price of the whole pack." },
        nude: { type: "boolean", description: "True only if the chat already promised him a nude." },
      },
      required: ["count", "text", "price_usd"],
      additionalProperties: false,
    },
  },
  {
    name: "send_moment_photos",
    description:
      "Sends him free photos from one \"in the moment\" set (a vault folder of photos from one scene and one moment) in one message, with a neutral caption. You choose how many of its photos go out (count; all of them when left out). Each set is used ONCE per fan: after this send the whole set is his used set and none of its photos can ever go to him again, also the ones you did not send, so for a fan who wants many photos send the whole set. read_fan_profile lists the sets still unused for him with their scene and size. Use it when he asks for more photos, normal or everyday photos, or a current photo, when he doubts you, as a free warm-up when he is warm, and as the free bonus after a purchase. The photos do not show the present moment: the caption never says now, trenutno, live, a place or what you are doing, and never claims they are new or only for him. If he later asks whether they are from right now, say yes briefly, with no detail. Not a sell move: no price, nothing about what is in them. Free for every fan, VIPs included, no daily limit; one set per reply (a VIP may get up to three sets in one reply). Refused when no unused set is left for him.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A neutral playful word or two or an emoji. Nothing about time, place or what is in them, no price." },
        scene: {
          type: "string",
          description:
            "The scene of the set, as read_fan_profile lists it (e.g. home, taxi, bathrobe, chair, bathroom). Use it when he asked for a current photo, to stay consistent with what you told him (said you are home: a home set), or to pick a set. Leave out to get the next unused set (the same scene as his last set when one is left).",
        },
        count: { type: "integer", minimum: 1, maximum: 20, description: "How many photos of the set to send. Leave out to send the whole set. The rest of the set is gone for him either way." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "ready_for_offer",
    description: "Tell the owner this fan is ready for a photo offer. Sends nothing to him. Only when you want to sell and send_photo is refused for lack of photos or none are available.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "A few words, no chat text." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  { name: "mark_english", description: "Put this fan on the USA list. Only when he writes to you in English in his own words.", inputSchema: none },
  { name: "stop_chat", description: "End this chat for good. Only when he may be under 18.", inputSchema: none },
  {
    name: "stop_non_buyer",
    description:
      "Stop answering him because you have tried everything and judge he will never buy. Sends nothing; the owner is told. He is answered again as soon as he pays anything. Refused unless he has spent nothing and has had enough paid offers over enough days; the result says why.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "A few words on why, no chat text." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

// Research chats with creators we follow: read, take notes, reply. Nothing that sells, hands over or touches lists.
export const RESEARCH_TOOLS = TOOLS.filter((t) => ["read_chat", "read_memory", "save_memory", "send_reply"].includes(t.name));

const DEFAULT_CHAT_MESSAGES = 30;
const MAX_CHAT_MESSAGES = 200;
const SALES_HISTORY_MESSAGES = 500;
const MAX_HOLD_MS = 40_000; // under the Action's one-minute MCP tool timeout
const PAGE_SIZE = 50;
// Owner, 6 Nov 2026: "in the moment" was taken in a taxi, "in the moment 1" at home. The scene now comes from the "(scene)" in the
// folder name (13 Nov 2026: home, bathrobe, chair, bathroom, entryway, restaurant, ...); these two cover old unnamed folders.
export const MOMENT_SCENES = { taxi: 0, home: 1 };
export const MOMENT_FOLDERS = ["in the moment", "in the moment 1", "in the moment 2", "in the moment 3", "in the moment 4", "in the moment 5"];

/**
 * The moment folders as they are named in the vault right now, oldest first. The owner renames and adds them
 * ("in the moment (taxi)", "in the moment 1 (home)", "in the moment (bathrobe)", "in the moment 7 (chair)", ...), so they are
 * matched by "in the moment" + optional number + optional "(scene)". Returns [{ name, index, scene, createdAt }].
 * Falls back to the fixed names when the folder list cannot be read.
 */
export function momentFolders(folders) {
  const found = [];
  for (const f of folders ?? []) {
    // Owner, 13 Nov 2026: every vault folder whose name starts with "in the moment" is a free set, whatever follows.
    const m = /^in the moment\b\s*(\d+)?\s*(?:\(([^)]*)\))?/i.exec((f.name ?? "").trim());
    if (m)
      found.push({
        name: f.name,
        index: m[1] ? Number(m[1]) : 0,
        scene: (m[2] ?? "").trim().toLowerCase() || (m[1] ? (Number(m[1]) === 1 ? "home" : null) : "taxi"),
        createdAt: Date.parse(f.createdAt ?? "") || 0,
      });
  }
  if (!found.length) return MOMENT_FOLDERS.map((name, index) => ({ name, index, scene: index === 0 ? "taxi" : index === 1 ? "home" : null, createdAt: 0 }));
  return found.sort((a, b) => a.createdAt - b.createdAt || a.index - b.index || a.name.localeCompare(b.name));
}
// Owner, 13 Nov 2026: the "in the moment" sets go out free to anyone, as often as the chat asks for them (was once per 24 hours).
const MOMENT_GAP_MS = 0;
// Owner, 13 Nov 2026: never the same photo to the same fan twice. Everything she ever sent him is read this far back.
const EVER_SENT_MESSAGES = 3000;
// Sets per reply: one, and up to three for a VIP (owner, 13 Nov 2026: the top spender wants many photos at once).
const MOMENT_SETS_PER_REPLY = 1;
const VIP_MOMENT_SETS_PER_REPLY = 3;

const ok = (text) => ({ text });
const refuse = (text) => ({ text, isError: true });

/**
 * He asks to see her: a photo, her face or body, "show me", "where are your photos", "I'll give you a gift for it".
 * Owner, 6 Nov 2026: a top spender asked for photos 8 times in a day and got only teasing; the owner then sold him $20 and
 * $25 photos within minutes. Serbian in Latin and Cyrillic, and English.
 */
export const asksForPhoto = (text) =>
  /(show me|send me|let me see|wanna see|want to see|see (more|your|all)|your (body|face|lips|ass|boobs|tits|pics?|photos?)|whole body|pics?\b|photos?\b|phots|picture|nudes?|selfie|gift for it|slik|fotk|posalji|pošalji|pokazi|pokaži|da te vidim|vidim te|da (ih |je )?vidim (te|tvoj|tvoje|tvoju|oci|oči|sise|guz|samo)|obecala si|obećala si|golisav|golu|голу|обећала си|tvoje telo|telo tvoje|слик|пошаљи|покажи|да те видим|да видим)/iu.test(text ?? "");

export class JobTools {
  replied = false;
  sentUuid = undefined; // the newest message we sent: it anchors the follow-up
  photoSent = false;
  momentSent = false;
  momentSets = 0; // sets sent in this reply
  wroteAgain = false;
  rebased = false;
  stopped = false;
  photoNudged = false; // the text-only reply to a photo request was refused once
  missedPhotoAsk = false;
  notBuying = false; // owner, 6 Nov 2026: the model judged he will never buy and the hard limits allowed it
  alerts = []; // { kind: "needs_person" | "offer", reason }
  #busy = false;
  #pool = null;
  #everSent = null;

  /**
   * @param {object} o
   * @param {ReturnType<import("./api.mjs").createApi>} o.api
   * @param {string} o.fanUuid
   * @param {string} o.newestUuid the newest personal message when the job began
   * @param {boolean} o.followUp
   * @param {boolean} [o.thanks] this reply thanks him for a tip: no paid photo in it
   * @param {boolean} [o.noSale] he had a refund or chargeback: no paid photo and no offer
   * @param {number} [o.sendAt] earliest time the first message may go out
   * @param {object} o.rules sales numbers from the Worker
   * @param {string} o.usaListUuid
   * @param {string=} o.ignoreListUuid
   * @param {() => Promise<{ok: boolean, reason?: string}>} o.gate asks the Worker whether sending is still allowed (pause, daily cap)
   */
  constructor({ api, fanUuid, newestUuid, followUp, thanks, noSale, vip, research, sendAt, rules, usaListUuid, ignoreListUuid, gate, sleep, now, random }) {
    this.api = api;
    this.research = !!research;
    this.fanUuid = fanUuid;
    this.newestUuid = newestUuid;
    this.followUp = followUp;
    this.thanks = !!thanks;
    this.noSale = !!noSale;
    this.vip = !!vip;
    this.sendAt = sendAt;
    this.rules = rules;
    this.usaListUuid = usaListUuid;
    this.ignoreListUuid = ignoreListUuid;
    this.gate = gate;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now ?? (() => Date.now());
    this.random = random ?? Math.random;
  }

  /** What the Worker is told when the job ends. It names ids and reasons, never chat text. */
  report() {
    if (this.missedPhotoAsk && !this.photoSent) this.alerts.push({ kind: "offer", reason: "asked for photos, got words only" });
    this.missedPhotoAsk = false;
    return { replied: this.replied, sentUuid: this.sentUuid, wroteAgain: this.wroteAgain, stopped: this.stopped, notBuying: this.notBuying, alerts: this.alerts };
  }

  async call(name, args) {
    if (this.research && !RESEARCH_TOOLS.some((t) => t.name === name)) return refuse("Not available in this chat.");
    if (this.notBuying && name.startsWith("send_")) return refuse("You stopped answering him. Send nothing.");
    switch (name) {
      case "read_chat": {
        const wanted = Math.min(Math.max(Number(args.count) || DEFAULT_CHAT_MESSAGES, 1), MAX_CHAT_MESSAGES);
        const chat = await this.readChat(wanted);
        return ok(this.research ? formatResearchChat(chat, this.fanUuid) : formatChat(chat, this.fanUuid, this.now()));
      }
      case "read_memory":
        return ok(splitNotes(await this.api.getNotes(this.fanUuid)).memory || "No notes yet: this chat is new.");
      case "save_memory":
        await this.api.putNotes(this.fanUuid, mergeNotes(await this.api.getNotes(this.fanUuid), String(args.text ?? "")));
        return ok("Saved.");
      case "send_reply":
        return this.#exclusive("You already replied.", () => this.#sendReply(String(args.text ?? "")), this.replied);
      case "hand_over": {
        const reason = String(args.reason ?? "");
        if (this.vip) {
          // Owner, 12 Nov 2026: a VIP is never stopped. The owner gets the alert, the bot keeps answering him.
          this.alerts.push({ kind: "needs_person", reason });
          return ok("Noted for the owner. He is a VIP: do not stop. Keep chatting and replying to him warmly now.");
        }
        await this.api.putNotes(this.fanUuid, withStopLine(await this.api.getNotes(this.fanUuid), reason, belgradeNow(this.now()), this.now()));
        await this.api.markChatUnread(this.fanUuid).catch(() => {});
        this.alerts.push({ kind: "needs_person", reason });
        return ok("Handed over. Do not reply.");
      }
      case "read_fan_profile": {
        const history = await this.#history(await this.readChat(SALES_HISTORY_MESSAGES));
        const insights = await this.api.getFanInsights(this.fanUuid).catch(() => null);
        const pool = await this.#getPool();
        const freeLeft = pool ? pool.free.filter((p) => !history.seen.has(p.uuid) && !history.offeredBefore.has(p.uuid)).length : 0;
        const paidLeft = pool ? paidCandidates(pool, history, this.vip).length : 0;
        // Owner, 6 Nov 2026: a top spender asked for photos three times and got only small talk because he had bought every paid photo.
        const moment = await this.#momentSets().catch(() => null);
        const momentLeft = moment ? moment.filter((s) => !s.used) : null;
        const photos = !pool
          ? "Photos: the photo stock could not be read this time (a temporary error, NOT out of stock). Do not hint at a photo in this reply and do not write anything about stock in your notes; check read_fan_profile again next time."
          : `Unseen photos left for him: ${freeLeft} free, ${paidLeft} paid.` +
            (momentLeft?.length
              ? ` Free "in the moment" sets still unused for him: ${momentLeft.length} (${momentLeft.map((s) => `${s.scene ?? "set"} ${s.uuids.length}`).join(", ")} photos; send_moment_photos, each set once per fan, free for everyone).`
              : momentLeft ? ' No free "in the moment" set left for him: every set was used for him already.' : "") +
            (paidLeft
              ? this.vip && !pool.ppv.some((p) => !history.seen.has(p.uuid))
                ? " His usual paid photos are used up; his paid offers now come from softer lingerie and warm-up photos, so price them a little below his usual (a pack of 3 to 5 around $12 to $25) and keep selling."
                : ""
              : ` OUT OF PAID PHOTOS for him: he has had every paid photo. Follow "Out of paid photos" in your instructions: call ready_for_offer with reason "out of paid photos" now${freeLeft ? ", and if he asks for photos give him a free one with send_photo kind free" : ""}; never dodge his request and never say something is waiting for him.`);
        return ok(`${profileText(insights, history, this.rules)}\n${photos}`);
      }
      case "send_photo":
        return this.#exclusive("One photo per reply. Stop here.", () => this.#sendPhoto(args), this.photoSent);
      case "send_ppv_pack":
        return this.#exclusive("One photo message per reply. Stop here.", () => this.#sendPack(args), this.photoSent);
      case "send_moment_photos":
        return this.#exclusive(
          this.vip ? `At most ${VIP_MOMENT_SETS_PER_REPLY} sets per reply. Stop here.` : "One set per reply. Stop here.",
          () => this.#sendMomentPhotos(args),
          this.momentSets >= (this.vip ? VIP_MOMENT_SETS_PER_REPLY : MOMENT_SETS_PER_REPLY),
        );
      case "ready_for_offer":
        if (this.noSale) return refuse("He is sold nothing after a refund or chargeback. Keep the chat warm and friendly.");
        this.alerts.push({ kind: "offer", reason: String(args.reason ?? "") });
        return ok("Noted. Keep the chat going as normal and say nothing about a photo.");
      case "mark_english":
        await this.api.addToList(this.usaListUuid, [this.fanUuid]);
        return ok("Marked.");
      case "stop_chat":
        this.stopped = true;
        return ok("Chat stopped.");
      case "stop_non_buyer": {
        if (this.replied || this.photoSent || this.momentSent) return refuse("You already sent him something in this turn. Keep answering for now.");
        const history = salesHistory(await this.readChat(SALES_HISTORY_MESSAGES), this.fanUuid, this.now(), this.rules);
        const insights = await this.api.getFanInsights(this.fanUuid).catch(() => null);
        const why = notBuyingRefusal(insights, history, this.now(), this.rules, { vip: this.vip, noSale: this.noSale });
        if (why) return refuse(why);
        this.notBuying = true;
        // Owner, 7 Nov 2026: a fan who keeps refusing to pay moves into the custom list "ignore".
        if (this.ignoreListUuid) await this.api.addToList(this.ignoreListUuid, [this.fanUuid]).catch(() => {});
        this.alerts.push({ kind: "not_buying", reason: String(args.reason ?? "").slice(0, 80) });
        return ok("Stopped. Send nothing more to him.");
      }
      default:
        return refuse("Unknown tool.");
    }
  }

  /** Runs one send at a time, and only once: a repeated call (a client retry during the hold) must not send it twice. */
  async #exclusive(message, run, alreadyDone) {
    if (alreadyDone || this.#busy) return refuse(message);
    this.#busy = true;
    try {
      return await run();
    } finally {
      this.#busy = false;
    }
  }

  async readChat(wanted) {
    const messages = [];
    let page = await this.api.fetchMessages(this.fanUuid);
    messages.push(...page);
    while (messages.length < wanted && page.length === PAGE_SIZE) {
      page = await this.api.fetchMessages(this.fanUuid, page.at(-1).uuid);
      messages.push(...page);
    }
    return messages.slice(0, wanted);
  }

  /** True when his newest messages ask to see her and at least one unseen photo is left for him. */
  async #photoAskOpen() {
    const messages = await this.readChat(SALES_HISTORY_MESSAGES).catch(() => null);
    if (!messages || !asksForPhoto(newFanMessages(messages, this.fanUuid))) return false;
    const pool = await this.#getPool();
    if (!pool) return false;
    const history = await this.#history(messages);
    return pool.free.some((p) => !history.seen.has(p.uuid)) || paidCandidates(pool, history, this.vip).length > 0;
  }

  #getPool() {
    // One retry: a single failed vault read once made the model note "no photo stock" for a top spender who still had 30+ photos.
    this.#pool ??= buildPool(this.api)
      .catch(() => buildPool(this.api))
      .catch(() => {
        // Never fail silently again (6 Nov 2026: a missing folder blocked every photo for hours): tell the owner.
        this.alerts.push({ kind: "offer", reason: "photo stock could not be read (check vault folders free and ppv)" });
        return null;
      })
      .then((pool) => this.#withoutMomentMedia(pool))
      .then((pool) => poolForFan(pool, this.fanUuid));
    return this.#pool;
  }

  /**
   * The free and paid pools without any photo that sits in an "in the moment" folder (owner, 13 Nov 2026): those go out only as
   * part of their set, once per fan, so a single free or paid photo never breaks a set open or repeats one.
   */
  async #withoutMomentMedia(pool) {
    if (!pool) return pool;
    const named = momentFolders(await Promise.resolve().then(() => this.api.listFolders()).catch(() => null));
    const media = await Promise.all(named.map(({ name }) => this.api.listFolderMedia(name).catch(() => [])));
    const inSets = new Set(media.flat().map((m) => m.uuid));
    if (!inSets.size) return pool;
    const keep = (list) => (list ?? []).filter((p) => !inSets.has(p.uuid));
    return { ...pool, free: keep(pool.free), ppv: keep(pool.ppv), preview: keep(pool.preview), vipExtra: keep(pool.vipExtra) };
  }

  /**
   * The chat anchor still holds. One exception per job (owner, 7 Nov 2026): if only the fan wrote more since
   * (nobody answered by hand, no refusal in his new words), move the anchor to his newest message once so the
   * photo or pack still goes out instead of being dropped.
   */
  #anchorHolds(messages, anchor) {
    const newest = newestPersonal(messages);
    if (newest?.uuid === anchor) return true;
    if (this.rebased || !newest || newest.sender.uuid !== this.fanUuid) return false;
    const idx = messages.findIndex((m) => m.uuid === anchor); // newest first: the newer messages are before it
    if (idx < 0) return false;
    if (messages.slice(0, idx).some((m) => m.sender.uuid !== this.fanUuid)) return false; // someone else wrote since
    if (/\b(ne|nemoj|stop|neću|necu|no|don'?t|not now|ne želim|ne zelim)\b/i.test(String(newest.text ?? ""))) return false;
    this.rebased = true;
    if (!this.replied) this.newestUuid = newest.uuid;
    return true;
  }

  async #sendReply(reply) {
    const { api, fanUuid } = this;
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");

    // The reply is ready early: hold the first message until its random send time.
    const hold = this.sendAt ? Math.min(this.sendAt - this.now(), MAX_HOLD_MS) : 0;
    if (hold > 0) await this.sleep(hold);

    // He wrote again or someone answered by hand while Claude was writing: this reply is out of date.
    if (newestPersonal(await api.fetchMessages(fanUuid))?.uuid !== this.newestUuid) {
      this.wroteAgain = true;
      return refuse("The chat changed. Do not reply. Stop here.");
    }

    const text = finalText(reply);
    if (!text) return refuse("Refused: no links, no mention of AI, and at most 600 characters. Rewrite it without those.");

    // He asked to see her and she has photos for him: the photo goes out in this reply, not only words (owner, 6 Nov 2026).
    if (!this.photoSent && !this.followUp && !this.thanks && !this.noSale && !this.research && (await this.#photoAskOpen())) {
      if (!this.photoNudged) {
        this.photoNudged = true;
        return refuse(
          "Not sent: he asked to see you and you have photos for him. Answer his ask with the photo itself, the way the owner sells: " +
            "send_photo (paid at his usual price, or free if he has had nothing warm from you yet) or send_ppv_pack, with your words as its short caption. " +
            "If you want one short line before it, call send_reply again with it and then the photo right after. Never only words.",
        );
      }
      this.missedPhotoAsk = true;
    }

    const [first, ...rest] = splitReply(text);
    await this.#sendPart(first);
    for (const part of rest) {
      await this.sleep(typingDelayMs(part));
      // He wrote or someone answered during the pause: the rest is out of date.
      if (!this.sentUuid || !stillNewest(await api.fetchMessages(fanUuid), this.sentUuid)) break;
      await this.#sendPart(part);
    }
    await api.putNotes(fanUuid, withReplyCount(await api.getNotes(fanUuid))).catch(() => {});
    return ok("Sent.");
  }

  /** Sends one message and marks the job replied. The newest message anchors the follow-up; if this read fails there is simply none. */
  async #sendPart(text) {
    await this.api.sendText(this.fanUuid, text);
    const newest = (await this.api.fetchMessages(this.fanUuid).catch(() => []))[0];
    this.sentUuid = newest && newest.sender.uuid !== this.fanUuid ? newest.uuid : undefined;
    this.replied = true;
  }

  /**
   * Every media uuid she ever sent him (one-to-one and mass messages, paid or free), read once per job far back.
   * Owner, 13 Nov 2026: the same photo never goes to the same fan twice.
   */
  #everSentMedia() {
    this.#everSent ??= this.readChat(EVER_SENT_MESSAGES)
      .then((messages) => new Set(messages.filter((m) => m.sender.uuid !== this.fanUuid).flatMap((m) => m.mediaUuids ?? [])))
      .catch(() => null);
    return this.#everSent;
  }

  /** Remembers what this job just sent, so a second send in the same job never repeats it. */
  async #noteSent(uuids) {
    const ever = await this.#everSentMedia();
    if (ever) for (const u of uuids) ever.add(u);
  }

  /** His sales history, with every photo he ever got from her counted as seen (never send one twice). */
  async #history(messages) {
    const history = salesHistory(messages, this.fanUuid, this.now(), this.rules);
    const ever = await this.#everSentMedia();
    if (ever) for (const u of ever) history.seen.add(u);
    return history;
  }

  /**
   * The "in the moment" sets and whether each is used for him: named in his note's used line, or any of its photos ever sent
   * to him (owner, 13 Nov 2026: one set is used once per fan, then forgotten for him). Null when the folders cannot be read.
   */
  async #momentSets() {
    const named = momentFolders(await Promise.resolve().then(() => this.api.listFolders()).catch(() => null));
    const [notes, ever, media] = await Promise.all([
      this.api.getNotes(this.fanUuid).catch(() => ""),
      this.#everSentMedia(),
      Promise.all(
        named.map(({ name }) =>
          this.api
            .listFolderMedia(name)
            .then((list) => list.filter((m) => m.status === "ready" && m.mediaType === "image").map((m) => m.uuid))
            .catch(() => []),
        ),
      ),
    ]);
    const usedNames = usedMomentSets(notes);
    return named
      .map((f, i) => ({ ...f, uuids: media[i], used: usedNames.has(f.name.trim().toLowerCase()) || media[i].some((u) => ever?.has(u)) }))
      .filter((f) => f.uuids.length);
  }

  /**
   * Free photos from one "in the moment" set he never had, in one message. Owner, 13 Nov 2026: each set is used once per fan;
   * the model picks how many of its photos go out, and the whole set is then his used set (written into his note) and is
   * never sent to him again. No daily limit, no first-buyer free-photo cap: free for everyone.
   */
  async #sendMomentPhotos(args) {
    const { api, fanUuid } = this;
    if (this.followUp) return refuse("No photos in a follow-up. Stop here.");
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || !this.#anchorHolds(messages, anchor)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const ever = await this.#everSentMedia();
    if (!ever) return refuse("His photo history could not be read this time. Send no set now; answer in words.");
    const sets = await this.#momentSets().catch(() => null);
    if (!sets) return refuse("The photo sets could not be read this time. Send no set now; answer in words.");
    const unused = sets.filter((s) => !s.used);
    if (!unused.length) return refuse(sets.length ? "He already had every photo set. Send none: answer in words, without promising a photo later." : "No such photos are available. Just answer in words.");
    const wanted = String(args.scene ?? "").trim().toLowerCase();
    let set;
    if (wanted) {
      set = unused.find((s) => s.scene === wanted) ?? unused.find((s) => s.name.toLowerCase().includes(wanted));
      if (!set) {
        const scenes = [...new Set(unused.map((s) => s.scene).filter(Boolean))];
        return refuse(`No unused ${wanted} set is left for him. Unused scenes: ${scenes.join(", ") || "none named"}. Pick one that fits what you told him, or answer in words.`);
      }
    } else {
      // Stay with the scene of his latest set when one is left, else the oldest unused set.
      const last = sets.filter((s) => s.used && s.scene).at(-1);
      set = (last && unused.find((s) => s.scene === last.scene)) ?? unused[0];
    }
    const photos = set.uuids.filter((u) => !ever.has(u));
    const count = args.count === undefined ? photos.length : Math.min(Math.max(Math.trunc(Number(args.count)) || 1, 1), photos.length);
    const uuids = photos.slice(0, count);
    if (!uuids.length) return refuse("That set has no photo left for him. Answer in words.");
    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    // The set is used for him now, also the photos he did not get. The note keeps it beyond any chat window.
    await api.putNotes(fanUuid, withUsedMomentSet(await api.getNotes(fanUuid), set.name)).catch(() => {});
    await this.#noteSent(uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.momentSent = true;
    this.momentSets++;
    return ok(`Sent ${uuids.length} photos from the ${set.scene ?? "photo"} set. That set is used for him now.`);
  }

  /** Several paid photos in one message with one free preview. Same gates as a paid photo; wider price range. */
  async #sendPack(args) {
    const { api, fanUuid, rules } = this;
    if (this.followUp) return refuse("No photos in a follow-up. Stop here.");
    if (this.noSale) return refuse("He is sold nothing after a refund or chargeback: no paid photo. Stop here.");
    if (this.thanks) return refuse("No paid photo in a thank-you for his tip: the next offer waits until he flirts again. Stop here.");
    const count = Number(args.count);
    const priceUsd = Number(args.price_usd);
    const maxPack = rules.packMaxPriceUsd ?? 40;
    if (!Number.isInteger(count) || count < 2 || count > 6) return refuse("Choose 2 to 6 photos.");
    if (!Number.isInteger(priceUsd) || priceUsd < 5 || priceUsd > maxPack) return refuse(`Choose a whole-dollar pack price from 5 to ${maxPack}.`);
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || !this.#anchorHolds(messages, anchor)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = await this.#history(messages);
    const firstBuyer = isFirstBuyer(await api.getFanInsights(fanUuid).catch(() => null), history, this.vip);
    // Same open-photo limit (maxOpenPaid) and waiting time as a single paid photo; never a pack as his first offer.
    const refusal = photoRefusal("pack", history, this.now(), rules.minPriceUsd, rules, firstBuyer);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const pack = pool && pickPack(pool, history, count, args.nude === true, this.random, this.vip);
    if (!pack) return refuse("Not enough unseen paid photos or previews for him. Send no pack: try send_photo kind paid, and if that is refused too, follow \"Out of paid photos\" (free photo if he wants photos, ready_for_offer).");

    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPpvPack(fanUuid, text, [pack.preview, ...pack.photos], pack.preview, priceUsd * 100);
    await this.#noteSent([pack.preview, ...pack.photos]);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(`Pack of ${count} paid photos with a free preview sent at $${priceUsd}.`);
  }

  async #sendPhoto(args) {
    const { api, fanUuid, rules } = this;
    if (this.followUp) return refuse("No photos in a follow-up. Stop here.");
    const kind = args.kind === "paid" ? "paid" : "free";
    if (this.noSale && kind === "paid") return refuse("He is sold nothing after a refund or chargeback: no paid photo. Stop here.");
    if (this.thanks && kind === "paid") return refuse("No paid photo in a thank-you for his tip: the next offer waits until he flirts again. Stop here.");
    const priceUsd = args.price_usd === undefined ? undefined : Number(args.price_usd);
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");

    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || !this.#anchorHolds(messages, anchor)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = await this.#history(messages);
    const firstBuyer = isFirstBuyer(await api.getFanInsights(fanUuid).catch(() => null), history, this.vip);
    const refusal = photoRefusal(kind, history, this.now(), priceUsd, rules, firstBuyer);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const photo = pool && pickPhoto(pool, kind, history, args.nude === true, this.random, this.vip);
    if (!photo)
      return refuse(
        kind === "paid"
          ? "No unseen paid photo is left for him. Follow \"Out of paid photos\": call ready_for_offer, and if he asked for photos send a free one with send_photo kind free instead."
          : "No unseen free photo is left for him either. Send no photo; call ready_for_offer and answer him in words.",
      );

    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPhoto(fanUuid, text, photo, kind === "paid" ? priceUsd * 100 : undefined);
    await this.#noteSent([photo]);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(kind === "paid" ? `Paid photo sent at $${priceUsd}.` : "Free photo sent.");
  }
}
