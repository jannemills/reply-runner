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
import { buildPool, photoRefusal, pickPhoto, profileText, salesHistory } from "./sales.mjs";

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
    name: "send_moment_photos",
    description:
      "Proof that you are really there right now: sends him ALL the photos of the vault folder \"in the moment\" at once, free, in one message with a short casual line. Use it only when he doubts you or does not believe you, or when you want to make sure he believes you. They were taken on the back seat of the car you are riding in (you are in a taxi right now). Not a sell move: no price, nothing about what is in them.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "One short casual line, no price." } },
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
];

// Research chats with creators we follow: read, take notes, reply. Nothing that sells, hands over or touches lists.
export const RESEARCH_TOOLS = TOOLS.filter((t) => ["read_chat", "read_memory", "save_memory", "send_reply"].includes(t.name));

const DEFAULT_CHAT_MESSAGES = 30;
const MAX_CHAT_MESSAGES = 200;
const SALES_HISTORY_MESSAGES = 500;
const MAX_HOLD_MS = 40_000; // under the Action's one-minute MCP tool timeout
const PAGE_SIZE = 50;

const ok = (text) => ({ text });
const refuse = (text) => ({ text, isError: true });

export class JobTools {
  replied = false;
  sentUuid = undefined; // the newest message we sent: it anchors the follow-up
  photoSent = false;
  momentSent = false;
  wroteAgain = false;
  stopped = false;
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
  constructor({ api, fanUuid, newestUuid, followUp, thanks, noSale, research, sendAt, rules, usaListUuid, gate, sleep, now, random }) {
    this.api = api;
    this.research = !!research;
    this.fanUuid = fanUuid;
    this.newestUuid = newestUuid;
    this.followUp = followUp;
    this.thanks = !!thanks;
    this.noSale = !!noSale;
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
    return { replied: this.replied, sentUuid: this.sentUuid, wroteAgain: this.wroteAgain, stopped: this.stopped, alerts: this.alerts };
  }

  async call(name, args) {
    if (this.research && !RESEARCH_TOOLS.some((t) => t.name === name)) return refuse("Not available in this chat.");
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

  /** All photos of the vault folder "in the moment" in one free message, when he doubts she is real or there. */
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
    const media = await api.listFolderMedia("in the moment").catch(() => []);
    const uuids = media.filter((m) => m.status === "ready" && m.mediaType === "image").map((m) => m.uuid);
    if (!uuids.length) return refuse("No such photos are available. Just answer in words.");
    const sentBefore = new Set(messages.filter((m) => m.sender.uuid !== fanUuid).flatMap((m) => m.mediaUuids ?? []));
    if (uuids.every((u) => sentBefore.has(u))) return refuse("He already got all of them in this chat. Do not send them again.");
    if (this.replied) await this.sleep(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.momentSent = true;
    return ok(`Sent ${uuids.length} photos.`);
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
