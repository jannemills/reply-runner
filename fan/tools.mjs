// The reply agent's tools. One JobTools object serves one job: the fan is fixed when it is built and no tool takes a fan id.
import {
  belgradeNow,
  finalText,
  formatChat,
  formatResearchChat,
  isHandedOver,
  mergeNotes,
  newestPersonal,
  splitNotes,
  splitReply,
  stillNewest,
  typingDelayMs,
  withReplyCount,
  withStopLine,
} from "./chat.mjs";
import { buildPool, notBuyingRefusal, photoRefusal, pickPack, pickPhoto, profileText, salesHistory } from "./sales.mjs";

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
      "Sends him the next free photo set he has not had yet (all its photos at once, free, in one message) with a neutral caption. Use it when he doubts you, in the flirt phase as a free warm-up when he is warm, or with scene taxi or home when he asks you for a current photo. The photos do not show the present moment: the caption never says now, trenutno, live, a place, a taxi or what you are doing, and never claims they are new or only for him. If he later asks whether they are from right now, say yes briefly, with no detail. Not a sell move: no price, nothing about what is in them. At most one set per fan per day; it is refused if he had one in the last 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A neutral playful word or two or an emoji. Nothing about time, place or what is in them, no price." },
        scene: {
          type: "string",
          enum: ["taxi", "home"],
          description: "Only when he asked you for a current photo (\"posalji mi trenutnu\"): taxi sends the set taken in a taxi, home the set taken at home, if he has not had it. Leave out otherwise.",
        },
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
// One scene at successive points in time (owner, 6 Nov 2026): sent in this order, one collection at a time.
// Owner, 6 Nov 2026: "in the moment" was taken in a taxi, "in the moment 1" at home. Sent on request for a current photo.
export const MOMENT_SCENES = { taxi: 0, home: 1 };
export const MOMENT_FOLDERS = ["in the moment", "in the moment 1", "in the moment 2", "in the moment 3", "in the moment 4", "in the moment 5"];
const MOMENT_GAP_MS = 24 * 60 * 60 * 1000;

const ok = (text) => ({ text });
const refuse = (text) => ({ text, isError: true });

export class JobTools {
  replied = false;
  sentUuid = undefined; // the newest message we sent: it anchors the follow-up
  photoSent = false;
  momentSent = false;
  wroteAgain = false;
  stopped = false;
  notBuying = false; // owner, 6 Nov 2026: the model judged he will never buy and the hard limits allowed it
  alerts = []; // { kind: "needs_person" | "offer", reason }
  #busy = false;
  #pool = null;

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
   * @param {() => Promise<{ok: boolean, reason?: string}>} o.gate asks the Worker whether sending is still allowed (pause, daily cap)
   */
  constructor({ api, fanUuid, newestUuid, followUp, thanks, noSale, vip, research, sendAt, rules, usaListUuid, gate, sleep, now, random }) {
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
    this.gate = gate;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now ?? (() => Date.now());
    this.random = random ?? Math.random;
  }

  /** What the Worker is told when the job ends. It names ids and reasons, never chat text. */
  report() {
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
        await this.api.putNotes(this.fanUuid, withStopLine(await this.api.getNotes(this.fanUuid), reason, belgradeNow(this.now())));
        await this.api.markChatUnread(this.fanUuid).catch(() => {});
        this.alerts.push({ kind: "needs_person", reason });
        return ok("Handed over. Do not reply.");
      }
      case "read_fan_profile": {
        const history = salesHistory(await this.readChat(SALES_HISTORY_MESSAGES), this.fanUuid, this.now(), this.rules);
        const insights = await this.api.getFanInsights(this.fanUuid).catch(() => null);
        const pool = await this.#getPool();
        const photos = pool
          ? `Unseen photos left for him: ${pool.free.filter((p) => !history.seen.has(p.uuid)).length} free, ${pool.ppv.filter((p) => !history.seen.has(p.uuid)).length} paid.`
          : "Photos: none available right now, so in the sell phase use ready_for_offer.";
        return ok(`${profileText(insights, history, this.rules)}\n${photos}`);
      }
      case "send_photo":
        return this.#exclusive("One photo per reply. Stop here.", () => this.#sendPhoto(args), this.photoSent);
      case "send_ppv_pack":
        return this.#exclusive("One photo message per reply. Stop here.", () => this.#sendPack(args), this.photoSent);
      case "send_moment_photos":
        return this.#exclusive("Already sent. Stop here.", () => this.#sendMomentPhotos(args), this.momentSent);
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

  #getPool() {
    this.#pool ??= buildPool(this.api).catch(() => null);
    return this.#pool;
  }

  async #sendReply(reply) {
    const { api, fanUuid } = this;
    if (isHandedOver(await api.getNotes(fanUuid))) return refuse("This chat is with a person. Stop here.");
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
   * The next "in the moment" collection he has not had, all its photos in one free message. The folders are one scene at
   * successive points in time, so they go out in order, one collection per send, never the same one twice and at most
   * one per MOMENT_GAP_MS for a fan.
   */
  async #sendMomentPhotos(args) {
    const { api, fanUuid } = this;
    if (this.followUp) return refuse("No photos in a follow-up. Stop here.");
    if (isHandedOver(await api.getNotes(fanUuid))) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || newestPersonal(messages)?.uuid !== anchor) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const sentAt = new Map(); // media uuid -> when we sent it to him
    for (const m of messages) if (m.sender.uuid !== fanUuid) for (const u of m.mediaUuids ?? []) sentAt.set(u, Date.parse(m.sentAt) || 0);
    const folders = await Promise.all(
      MOMENT_FOLDERS.map((name) =>
        api
          .listFolderMedia(name)
          .then((media) => media.filter((m) => m.status === "ready" && m.mediaType === "image").map((m) => m.uuid))
          .catch(() => []),
      ),
    );
    const scene = Object.hasOwn(MOMENT_SCENES, args.scene) ? args.scene : null;
    let uuids;
    if (scene) {
      // He asked for a current photo: the taxi or home set, only if he never had it (no daily limit for a request).
      const other = scene === "taxi" ? "home" : "taxi";
      const set = folders[MOMENT_SCENES[scene]];
      if (!set.length) return refuse("No such photos are available. Just answer in words.");
      if (set.some((u) => sentAt.has(u)))
        return refuse(folders[MOMENT_SCENES[other]].some((u) => sentAt.has(u)) || !folders[MOMENT_SCENES[other]].length
          ? "He already had both current sets. Send none: answer in words."
          : `He already had the ${scene} set. Send the ${other} set if it fits what you told him, or answer in words.`);
      uuids = set;
    } else {
      const lastMoment = Math.max(0, ...folders.flat().map((u) => sentAt.get(u) ?? 0));
      if (lastMoment && this.now() - lastMoment < MOMENT_GAP_MS)
        return refuse("He got a photo set less than a day ago. No more today: just answer in words.");
      // Next in time order after the latest collection he already has.
      const lastIndex = folders.findLastIndex((f) => f.some((u) => sentAt.has(u)));
      uuids = folders.slice(lastIndex + 1).find((f) => f.length);
      if (!uuids) return refuse(lastIndex >= 0 ? "He already got every photo set. Do not send them again." : "No such photos are available. Just answer in words.");
    }
    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.momentSent = true;
    return ok(`Sent ${uuids.length} photos.`);
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
    if (isHandedOver(await api.getNotes(fanUuid))) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || newestPersonal(messages)?.uuid !== anchor) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = salesHistory(messages, fanUuid, this.now(), rules);
    // Same open-photo limit (maxOpenPaid) and waiting time as a single paid photo.
    const refusal = photoRefusal("paid", history, this.now(), rules.minPriceUsd, rules);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const pack = pool && pickPack(pool, history, count, args.nude === true, this.random);
    if (!pack) return refuse("Not enough unseen photos or previews for him. Send no pack; use send_photo or ready_for_offer instead.");

    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPpvPack(fanUuid, text, [pack.preview, ...pack.photos], pack.preview, priceUsd * 100);
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
    if (isHandedOver(await api.getNotes(fanUuid))) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");

    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor || newestPersonal(messages)?.uuid !== anchor) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = salesHistory(messages, fanUuid, this.now(), rules);
    const refusal = photoRefusal(kind, history, this.now(), priceUsd, rules);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const photo = pool && pickPhoto(pool, kind, history, args.nude === true, this.random);
    if (!photo) return refuse("No unseen photo is available for him. Send no photo; call ready_for_offer instead.");

    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPhoto(fanUuid, text, photo, kind === "paid" ? priceUsd * 100 : undefined);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(kind === "paid" ? `Paid photo sent at $${priceUsd}.` : "Free photo sent.");
  }
}
