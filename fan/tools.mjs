// The reply agent's tools. One JobTools object serves one job: the fan is fixed when it is built and no tool takes a fan id.
import {
  belgradeNow,
  finalText,
  formatChat,
  formatResearchChat,
  handedOverBefore,
  isHandedOver,
  mergeNotes,
  newFanMessages,
  newestPersonal,
  paymentHold,
  buyerNudgeDue,
  withBuyerNudge,
  repeatedLine,
  splitNotes,
  splitReply,
  stillNewest,
  typingDelayMs,
  usedMomentSets,
  withReplyCount,
  withStopLine,
  withUsedMomentSet,
  withPaymentHold,
} from "./chat.mjs";
import { withTypo } from "./typo.mjs";
import { MAX_VOICE_WORDS, speak, spokenText, voiceName, wordCount } from "./voice.mjs";
import { packRefusal, buildPool, poolForFan, isFirstBuyer, freeTalkRun, sincePaidRun, MAX_FREE_STREAK, VIP_MAX_FREE_STREAK, FREE_PER_HOUR, VIP_FREE_PER_HOUR, notBuyingRefusal, paidCandidates, photoRefusal, priceAnchorUsd, pickPack, pickPhoto, profileText, salesHistory, turnsAwayMoney, sendsHimAway, saysGoodbye, raisesPaying, saysCannotPay } from "./sales.mjs";

const none = { type: "object", properties: {}, additionalProperties: false };

export const TOOLS = [
  {
    name: "read_chat",
    description: "Read this fan's latest messages, oldest first. For a long search through the history (he refers to something earlier, a riddle or quiz check) set deep true.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 200, description: "How many messages. Default 30 (15 for a fan who has spent nothing, at most 40 unless deep)." },
        deep: { type: "boolean", description: "Read the whole chat, up to 200 messages. Use it when he asks about or refers to something specific from earlier." },
      },
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
      "Send him one photo with a one-line caption, after your text reply if you send one. The photo is picked for you, unseen by him; free photos come from the newest \"free <date>\" folder first, then the older free photos. kind free, or kind paid with price_usd. It may be refused; the result says why.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["free", "paid"] },
        text: { type: "string", description: "One short line that says nothing about what is in the photo." },
        price_usd: { type: "integer", minimum: 3, maximum: 100, description: "Only for kind paid." },
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
        price_usd: { type: "integer", minimum: 5, maximum: 200, description: "Price of the whole pack." },
        nude: { type: "boolean", description: "True only if the chat already promised him a nude." },
      },
      required: ["count", "text", "price_usd"],
      additionalProperties: false,
    },
  },
  {
    name: "send_moment_photos",
    description:
      "Sends him ONE free photo (two at most, when he clearly asks for more) from an \"in the moment\" set (a vault folder of photos from one scene and one moment), with a neutral caption. Owner, 24 Nov 2026: free photos go one per send, never in bulk. A set he has started is continued on the next send (same scene, the next photo he has not had); no photo ever goes to him twice. read_fan_profile lists the sets with photos left for him. Refused after four free photo messages in a row (a VIP six) without a paid offer between them (then sell a small paid single instead), and when no unused set is left for him.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A neutral playful word or two or an emoji. Nothing about time, place or what is in them, no price." },
        scene: {
          type: "string",
          description:
            "The scene of the set, as read_fan_profile lists it (e.g. home, taxi, bathrobe, chair, bathroom). Use it when he asked for a current photo, to stay consistent with what you told him (said you are home: a home set), or to pick a set. Leave out to get the next unused set (the same scene as his last set when one is left).",
        },
        count: { type: "integer", minimum: 1, maximum: 2, description: "How many photos to send: 1 (default, almost always) or 2 when he clearly asks for more. The rest of the set stays for his next free photo." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_selfie",
    description:
      "Sends him one or two free selfies of you from the vault folder \"selfie\" (owner, 22 Nov 2026), in one message, with a neutral caption. For when a plain selfie fits: he asks for a selfie, a normal or everyday picture, your face, how you look right now, or wants proof that you are real; also a light free gesture when it fits the chat. Each selfie goes to the same fan only once, ever. Refused in a follow-up, in a chat handed to a person, when the chat changed, and when he already had every selfie.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A neutral playful word or two or an emoji (for example \"evo me\", \"ovako 🙈\"). Nothing about time, place or what is in it, no price." },
        count: { type: "integer", minimum: 1, maximum: 2, description: "How many selfies to send, 1 (default) or 2." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_tip_photos",
    description:
      "Only in the reply to a tip (not a purchase): the tip pays for the paid photos he was offered, so give him paid-stock photos for free in one message. count 1 to 3 (as many as his tip covers: about one photo per $5 to $6 of tip, or as many locked offers as he left unopened, at most 3). Photos he has not seen come from the paid stock; a caption of a few words, no price, never says it is for the tip. Refused outside a tip thank-you and when no unseen paid photo is left.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A few personal words, e.g. \"evo, ovo je tvoje\". No price, no mention of the tip or payment." },
        count: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["text", "count"],
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
  {
    name: "payment_trouble",
    description:
      "Call cannot_pay when he says he cannot pay right now (card declined or not activated, no money until payday, a wallet that fails). For 24 hours, or until he buys, no new paid offer goes to him and at most one free photo. Call works_again when he says his payment works now; then one small easy offer may follow.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["cannot_pay", "works_again"] },
        reason: { type: "string", description: "A few words such as \"card not activated\" or \"money tomorrow\". No card numbers or other payment data." },
      },
      required: ["state"],
      additionalProperties: false,
    },
  },
  { name: "mark_english", description: "Put this fan on the USA list. Only when he writes to you in English in his own words.", inputSchema: none },
  { name: "stop_chat", description: "End this chat for good. Only when he may be under 18.", inputSchema: none },
  {
    name: "stop_non_buyer",
    description:
      "Stop answering him because you have tried everything and judge he will never buy. Sends nothing; the owner is told. He is answered again as soon as he pays anything. Refused if he ever bought content or tipped (a subscription alone does not count) and until he has had enough paid offers over enough days; the result says why. He then goes on the ignore list.",
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
const TRIMMED_CHAT_MESSAGES = 15;
const TRIMMED_MAX_CHAT_MESSAGES = 40;
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
// Owner, 22 Nov 2026: a vault folder of plain selfies. The owner typed it "selife"; both spellings (and "selfies") are the folder.
export const isSelfieFolder = (name) => /^(selfies?|selife)$/i.test(String(name ?? "").trim());
const SELFIES_PER_REPLY = 2;
// Owner, 13 Nov 2026: the "in the moment" sets go out free to anyone, as often as the chat asks for them (was once per 24 hours).
const MOMENT_GAP_MS = 0;
// Owner, 13 Nov 2026: never the same photo to the same fan twice. Everything she ever sent him is read this far back.
const EVER_SENT_MESSAGES = 3000;
// Owner, 24 Nov 2026 (later): "free photos should be mostly only 1 per send, not bulk free photos in one send".
// One moment message per reply (a VIP two), one photo per message by default and at most MOMENT_MAX_PER_SEND.
const MOMENT_SETS_PER_REPLY = 1;
const VIP_MOMENT_SETS_PER_REPLY = 2;
const MOMENT_MAX_PER_SEND = 2;

const ok = (text) => ({ text });
const refuse = (text) => ({ text, isError: true });

/**
 * Review, 24 Nov 2026 (evening): "evo nesto malo smelije" and "ovu pazi" went out with no photo attached. A line that announces a picture
 * ("evo ...", "ovu pazi", "look at this", "here is one") must not be sent as text when no photo went out in this reply.
 */
export const announcesPhoto = (text) =>
  /\bevo\b[^.!?\n]{0,24}\b(nesto|nešto|slik\w*|foto\w*|jednu|ovu|ovo|ovaj|malo\s+smel\w*)|\bovu\s+(pazi|vidi|gledaj)|\b(pazi|vidi|gledaj)\s+ovu\b|\b(look at|check out)\s+(this|that)\b|\bhere(?:'s| is)\s+(a|one|my|something)\s+(pic|photo|picture|selfie|one)\b|\bhere you go\b|\b(sending|sent)\s+you\s+(a|one|something)\b|(?:^|[^\p{L}])(?:šaljem|saljem|poslala sam)\s+ti\b|\bti je ova\b|\bov[aeo]\s+(ovdje|ovde|ovdi)\b/iu.test(String(text ?? ""));

/** Review, 26 Nov 2026: stock lines that went word for word to 14+ fans in two days, none answered. */
export const stockLine = (text) =>
  /\bno (pressure|rush)\b|\b(glad|like that|love that) you(?:'|’)?re here\b|\bglad you (wrote|popped in|came)\b|\bmade my (day|morning|afternoon|evening|night)\b|\bnema (pritiska|žurbe|zurbe)\b/iu.test(String(text ?? ""));

/**
 * Review, 26 Nov 2026: a caption claimed a vault photo was made just for him ("vec jesam... bas za tebe, ovaj put sprijeda").
 * Photos are never claimed as taken right now or for him (owner rule: no moment claims on photo sets).
 */
export const momentClaim = (text) =>
  /\b(upravo|ba[sš] sad|maloprije|ve[cć] jesam|just (took|made|shot|snapped)|took (it|this|one) (just )?(now|for you)|made (it|this|one) (just )?for you)\b|\b(slikala|uslikala|napravila) (sam )?(se |je |ovu |ovo )?(sad|upravo|za tebe|samo za tebe)\b/iu.test(String(text ?? ""));

/**
 * Sales history, 27 Nov 2026: "one more on me" followed by a locked set ended a buyer's evening, and "unlock or tip, whichever's easier"
 * turned $7-10 unlocks into ~$5 tips eight times. A paid caption never calls the photo a gift or free, and never offers a tip instead.
 * Returns the refusal text, or null when the caption may go.
 */
export function paidCaptionProblem(text) {
  const t = String(text ?? "");
  if (/\b(gift|bonus|on me|on the house|for free|free one|freebie|it'?s free|poklon\w*|bonus\w*|besplatn\w*|gratis|[cč]astim|regalo|geschenk|cadeau)\b/iu.test(t))
    return "Not sent: this is a paid offer, but the caption calls it a gift, bonus or free. Never call a locked photo a gift (a buyer stopped after \"on me\" came locked). Give it his own words or a short tease and call it again.";
  if (/\b(tip|tips|tipping|napojnic\w*|bak[sš]i[sš]\w*|propin\w*|mancia)\b/iu.test(t))
    return "Not sent: a paid caption never mentions a tip (\"unlock or tip\" turned unlocks into smaller tips eight times). Leave tips out of it and call it again.";
  return null;
}

const QUESTION_START = /^(which|where|what|how|when|why|who|do|did|does|are|were|is|was|have|has|will|would|can|could|tell me|koj\w*|gde|gdje|[sš]ta|kako|kad\w*|za[sš]to|ko|da li|jel|je l|jesi|ima[sš])\b/iu;
/** A line that asks him something, with or without a question mark. */
export const isQuestion = (text) => {
  const t = String(text ?? "").trim();
  if (t.includes("?")) return true;
  return t.split(/(?<=[.!…])\s+|\.\.\.\s*/u).some((part) => QUESTION_START.test(part.trim().replace(/^[^\p{L}]+/u, "")));
};

const INTERVIEW_HOURS = 12;
/**
 * Sales history, 27 Nov 2026: the morning after the top spender bought three packs, the replier kept asking him about the photos and he
 * wrote "Repetitive questions and behavior..." and stopped opening the chat. True when he bought within INTERVIEW_HOURS, her last two
 * lines since that purchase were questions, and this line is one too.
 */
export function postBuyInterview(messages, fanUuid, now, text) {
  if (!isQuestion(text)) return false;
  const bought = messages
    .filter((m) => m.sender?.uuid !== fanUuid && m.purchasedAt)
    .map((m) => Date.parse(m.purchasedAt))
    .filter(Boolean);
  if (!bought.length) return false;
  const lastBuy = Math.max(...bought);
  if (now - lastBuy > INTERVIEW_HOURS * 3600_000) return false;
  const hers = messages
    .filter((m) => m.sender?.uuid !== fanUuid && m.text && Date.parse(m.sentAt) > lastBuy && !m.hasMedia)
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  if (hers.length < 2) return false;
  return hers.slice(-2).every((m) => isQuestion(m.text));
}

/**
 * He asks to see her: a photo, her face or body, "show me", "where are your photos", "I'll give you a gift for it".
 * Owner, 6 Nov 2026: a top spender asked for photos 8 times in a day and got only teasing; the owner then sold him $20 and
 * $25 photos within minutes. Serbian in Latin and Cyrillic, and English.
 */
export const asksForPhoto = (text) =>
  /(show me|send me|let me see|wanna see|want to see|see (more|your|all)|your (body|face|lips|ass|boobs|tits|pics?|photos?)|whole body|pics?\b|photos?\b|phots|picture|nudes?|selfie|gift for it|slik|sli[cč]ic|сличиц|fotk|posalji|pošalji|pokazi|pokaži|da te vidim|vidim te|da (ih |je )?vidim (te|tvoj|tvoje|tvoju|oci|oči|sise|guz|samo)|obecala si|obećala si|golisav|golu|голу|обећала си|tvoje telo|telo tvoje|слик|пошаљи|покажи|да те видим|да видим)/iu.test(text ?? "");

export class JobTools {
  replied = false;
  acted = false; // the model tried to send something, handed him over or ended the chat
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
  #queue = Promise.resolve();
  #pool = null;
  #everSent = null;
  #locked = null; // paid photos he was offered and never bought (owner, 26 Nov 2026)

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
  constructor({ api, fanUuid, newestUuid, followUp, freeHook, thanks, tipGift, noSale, vip, trimChat, research, voice, speakFn, sendAt, rules, usaListUuid, ignoreListUuid, gate, sleep, now, random }) {
    this.voice = !!voice; // owner, 21 Nov 2026: this fan gets short Serbian lines as voice notes (VOICE_FAN_UUIDS)
    this.speakFn = speakFn ?? speak;
    this.api = api;
    this.research = !!research;
    this.fanUuid = fanUuid;
    this.newestUuid = newestUuid;
    this.followUp = followUp;
    // Owner, 28 Nov 2026 ("we should make the interest, we are able to send free images"): a message to a fan who has never written
    // (joiner opener, silent re-engage, his like or comment) may carry one free photo or selfie as the hook; never a paid one.
    this.freeHook = !!freeHook;
    this.thanks = !!thanks;
    this.tipGift = !!tipGift; // owner, 19 Nov 2026: a tip pays for the paid photos he was offered, so the thank-you may carry free paid-stock photos
    this.noSale = !!noSale;
    this.vip = !!vip;
    this.trimChat = !!trimChat;
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
    if (name.startsWith("send_") || ["hand_over", "stop_chat", "stop_non_buyer"].includes(name)) this.acted = true;
    if (["send_photo", "send_ppv_pack", "send_moment_photos", "send_selfie"].includes(name)) this.photoTried = true;
    if (name === "send_ppv_pack" || (name === "send_photo" && args.kind === "paid")) this.paidTried = true;
    switch (name) {
      case "read_chat": {
        // Owner, 17 Nov 2026: a $0 fan's chat is read short (15, at most 40) unless the model asks for the whole chat with deep.
        const trim = this.trimChat && args.deep !== true;
        const wanted = Math.min(Math.max(Number(args.count) || (args.deep === true ? MAX_CHAT_MESSAGES : trim ? TRIMMED_CHAT_MESSAGES : DEFAULT_CHAT_MESSAGES), 1), trim ? TRIMMED_MAX_CHAT_MESSAGES : MAX_CHAT_MESSAGES);
        const chat = await this.readChat(wanted);
        return ok(this.research ? formatResearchChat(chat, this.fanUuid) : formatChat(chat, this.fanUuid, this.now()));
      }
      case "read_memory":
        return ok(splitNotes(await this.api.getNotes(this.fanUuid)).memory || "No notes yet: this chat is new.");
      case "save_memory":
        await this.api.putNotes(this.fanUuid, mergeNotes(await this.api.getNotes(this.fanUuid), String(args.text ?? "")));
        return ok("Saved.");
      case "send_reply":
        return this.#exclusive("You already replied.", () => this.#sendReply(String(args.text ?? "")), () => this.replied);
      case "hand_over": {
        const reason = String(args.reason ?? "");
        if (this.vip) {
          // Owner, 12 Nov 2026: a VIP is never stopped. The owner gets the alert, the bot keeps answering him.
          this.alerts.push({ kind: "needs_person", reason });
          return ok("Noted for the owner. He is a VIP: do not stop. Keep chatting and replying to him warmly now.");
        }
        const notesNow = await this.api.getNotes(this.fanUuid);
        if (handedOverBefore(notesNow, reason, this.now())) {
          this.alerts.push({ kind: "needs_person", reason: `${reason} again, bot answers` });
          return ok("This chat was already handed over for this in the last day and nobody took it. Do not hand over again: answer him yourself now, warmly, following your rules, and keep selling where it fits.");
        }
        await this.api.putNotes(this.fanUuid, withStopLine(notesNow, reason, belgradeNow(this.now()), this.now()));
        await this.api.markChatUnread(this.fanUuid).catch(() => {});
        this.alerts.push({ kind: "needs_person", reason });
        return ok("Handed over. Do not reply.");
      }
      case "read_fan_profile": {
        const history = await this.#history(await this.readChat(SALES_HISTORY_MESSAGES));
        const insights = await this.api.getFanInsights(this.fanUuid).catch(() => null);
        const pool = await this.#getPool();
        const freeLeft = pool ? pool.free.filter((p) => !history.seen.has(p.uuid) && !history.offeredBefore.has(p.uuid)).length : 0;
        const paidLeft = pool ? paidCandidates(pool, history, this.vip || history.bought > 0).length : 0;
        // Owner, 6 Nov 2026: a top spender asked for photos three times and got only small talk because he had bought every paid photo.
        const moment = await this.#momentSets().catch(() => null);
        const momentLeft = moment ? moment.filter((s) => !s.used) : null;
        const photos = !pool
          ? "Photos: the photo stock could not be read this time (a temporary error, NOT out of stock). Do not hint at a photo in this reply and do not write anything about stock in your notes; check read_fan_profile again next time."
          : `Unseen photos left for him: ${freeLeft} free, ${paidLeft} paid.` +
            (momentLeft?.length
              ? ` Free "in the moment" sets with photos left for him: ${momentLeft.length} (${momentLeft.map((s) => `${s.scene ?? "set"}${s.started ? " (started)" : ""}`).join(", ")}; send_moment_photos sends ONE photo per send, free for everyone).`
              : momentLeft ? ' No free "in the moment" set left for him: every set was used for him already.' : "") +
            (paidLeft
              ? this.vip && !pool.ppv.some((p) => !history.seen.has(p.uuid))
                ? " His usual paid photos are used up; his paid offers now come from softer lingerie and warm-up photos, so price them a little below his usual (a pack of 3 to 5 around $12 to $25) and keep selling."
                : ""
              : ` OUT OF PAID PHOTOS for him: he has had every paid photo. Follow "Out of paid photos" in your instructions: call ready_for_offer with reason "out of paid photos" now${freeLeft ? ", and if he asks for photos give him a free one with send_photo kind free" : ""}; never dodge his request and never say something is waiting for him.`);
        const notesText = await this.api.getNotes(this.fanUuid).catch(() => "");
        const hold = paymentHold(notesText, this.now());
        // Review, 25 Nov 2026: the hold ended at 15:41 but the model's own memory still said "no paid offers while cannot_pay holds", so a very
        // hot fan got four free photos and no offer for hours. Say plainly when the hold is over.
        const holdEnded = !hold && /^Payment hold:/m.test(String(notesText ?? ""));
        const holdText = hold && !(history.lastBoughtAt && history.lastBoughtAt > hold.setAt)
          ? `\nPayment hold: he said he cannot pay right now (until ${new Date(hold.until).toISOString().slice(0, 16)} UTC, or until he says it works or buys). No new paid offer; help him and stay warm.`
          : holdEnded
            ? "\nPayment hold: ENDED. Whatever your notes say about cannot_pay or \"no offers\", that is over: when he is hot, make one small, easy paid offer (or ask once, lightly, whether his payment works now) instead of more free photos. If he says again it still fails, call payment_trouble again."
          : "";
        return ok(`${profileText(insights, history, this.rules)}\n${photos}${holdText}`);
      }
      case "send_photo":
        return this.#exclusive("One photo per reply. Stop here.", () => this.#sendPhoto(args), () => this.photoSent);
      case "send_ppv_pack":
        return this.#exclusive("One photo message per reply. Stop here.", () => this.#sendPack(args), () => this.photoSent);
      case "send_moment_photos":
        return this.#exclusive(
          this.vip ? `At most ${VIP_MOMENT_SETS_PER_REPLY} sets per reply. Stop here.` : "One free photo message from the sets per reply. Stop here.",
          () => this.#sendMomentPhotos(args),
          () => this.momentSets >= (this.vip ? VIP_MOMENT_SETS_PER_REPLY : MOMENT_SETS_PER_REPLY),
        );
      case "send_selfie":
        return this.#exclusive("One photo message per reply. Stop here.", () => this.#sendSelfie(args), () => this.photoSent || this.momentSent);
      case "send_tip_photos":
        return this.#exclusive("One photo message per reply. Stop here.", () => this.#sendTipPhotos(args), () => this.photoSent || this.momentSent);
      case "ready_for_offer":
        if (this.noSale) return refuse("He is sold nothing after a refund or chargeback. Keep the chat warm and friendly.");
        this.alerts.push({ kind: "offer", reason: String(args.reason ?? "") });
        return ok("Noted. Keep the chat going as normal and say nothing about a photo.");
      case "payment_trouble": {
        const notes = await this.api.getNotes(this.fanUuid);
        const cannot = args.state === "cannot_pay";
        await this.api.putNotes(this.fanUuid, withPaymentHold(notes, cannot ? String(args.reason ?? "cannot pay right now") : null, this.now()));
        return ok(cannot
          ? "Noted. No new paid offer to him for now and at most one free photo. Help him with the one concrete step that fits, stay warm, and when he says it works, call payment_trouble with works_again."
          : "Noted. His payment works again: one small, easy offer may go out now.");
      }
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
  // 27 Nov 2026: a send called alongside another was refused as "already sent" and the photo or the line was lost. Calls now wait their turn.
  async #exclusive(message, run, alreadyDone) {
    const turn = this.#queue.then(() => (alreadyDone() ? refuse(message) : run()));
    this.#queue = turn.catch(() => {});
    return turn;
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
    return pool.free.some((p) => !history.seen.has(p.uuid)) || paidCandidates(pool, history, this.vip || history.bought > 0).length > 0;
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
  /** Owner, 28 Nov 2026 (free photo hook): a chat that holds only automations has no personal anchor; it holds while nobody personal wrote. */
  #anchorOk(messages) {
    const anchor = this.replied ? this.sentUuid : this.newestUuid;
    if (!anchor) return !this.replied && !newestPersonal(messages);
    return this.#anchorHolds(messages, anchor);
  }

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

  /** Waits; for a VIP the fan sees "typing..." meanwhile (owner, 17 Nov 2026). */
  async #wait(ms) {
    if (!this.vip || !this.api.setTyping) return this.sleep(ms);
    for (let left = ms; left > 0; left -= 4000) {
      await this.api.setTyping(this.fanUuid, true);
      await this.sleep(Math.min(left, 4000));
    }
    await this.api.setTyping(this.fanUuid, false);
  }

  async #sendReply(reply) {
    const { api, fanUuid } = this;
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");

    // The reply is ready early: hold the first message until its random send time.
    const hold = this.sendAt ? Math.min(this.sendAt - this.now(), MAX_HOLD_MS) : 0;
    if (hold > 0) await this.#wait(hold);

    // He wrote again or someone answered by hand while Claude was writing: this reply is out of date.
    const latest = await api.fetchMessages(fanUuid);
    if (newestPersonal(latest)?.uuid !== this.newestUuid) {
      this.wroteAgain = true;
      return refuse("The chat changed. Do not reply. Stop here.");
    }

    const text = finalText(reply);
    if (!text) return refuse("Refused: no links, no mention of AI, and at most 600 characters. Rewrite it without those.");

    // Owner, 27 Nov 2026: money is never turned away and a fan who is writing is never sent away.
    const selling = !this.thanks && !this.noSale && !this.research;
    if (selling) {
      const his = newFanMessages(latest, fanUuid);
      const held = saysCannotPay(his) || Boolean(paymentHold(await api.getNotes(fanUuid).catch(() => null), this.now()));
      if (!held && turnsAwayMoney(text))
        return refuse(
          "Not sent: never tell him he does not need to pay, spend, subscribe or unlock. Say yes warmly and give him the paid step: send_ppv_pack or send_photo kind paid with your yes as its caption, then at most one short line.",
        );
      if (sendsHimAway(text) && !saysGoodbye(his) && (this.awayRefusals ??= 0) < 3) {
        this.awayRefusals += 1;
        return refuse("Not sent: he is not leaving, so never send him to sleep, to rest or to enjoy his day. Keep him in the chat and move to the paid step (send the photo first), or ask one thing that pulls him closer.");
      }
      if (!held && !this.followUp && !this.paidTried && raisesPaying(his) && (this.payRefusals ??= 0) < 2) {
        this.payRefusals += 1;
        return refuse(
          "Not sent: he just brought up paying. This is the sale. Call send_ppv_pack or send_photo kind paid NOW, with your warm yes as its caption. Only after that call (sent or refused) use send_reply, and say nothing against paying.",
        );
      }
      // A sell reminder fired and no photo tool was called since: remind once more, so the line does not go out in place of the offer.
      if (this.offerOwed && !this.photoTried && !this.followUp && !this.offerReminded) {
        this.offerReminded = true;
        return refuse(
          "Not sent: you have not called a photo tool yet. Call send_photo or send_ppv_pack now, with this line as its caption. Only if he is sad, worried or saying goodnight, call send_reply again and it will go out.",
        );
      }
    }

    // He asked to see her and she has photos for him: the photo goes out in this reply, not only words (owner, 6 Nov 2026).
    if (!this.photoSent && !this.followUp && !this.thanks && !this.noSale && !this.research && (await this.#photoAskOpen())) {
      if (!this.photoNudged) {
        this.photoNudged = true;
        this.offerOwed = true;
        return refuse(
          "Not sent: he asked to see you and you have photos for him. Answer his ask with the photo itself, the way the owner sells: " +
            "send_photo (paid at his usual price, or free if he has had nothing warm from you yet) or send_ppv_pack, with your words as its short caption. " +
            "Call the photo tool NOW, before any send_reply: your line goes in its caption. Only if the photo is refused, send_reply with words. Never only words.",
        );
      }
      this.missedPhotoAsk = true;
    }

    // A fan who never paid must not get endless free text (owner, 15 Nov 2026: 14 hours of free sexting, no sale). After many text
    // replies with no photo, the next step is the small first unlock; one refusal, then the reply may go out so he is never left unanswered.
    if (!this.photoSent && !this.followUp && !this.thanks && !this.noSale && !this.research && !this.vip && !this.freeTalkNudged) {
      const limit = this.rules.freeTalkMaxReplies ?? 12;
      const chat = await this.readChat(SALES_HISTORY_MESSAGES).catch(() => null);
      if (chat && freeTalkRun(chat, this.fanUuid) >= limit) {
        const history = await this.#history(chat);
        if (isFirstBuyer(await api.getFanInsights(fanUuid).catch(() => null), history, this.vip)) {
          this.freeTalkNudged = true;
        this.offerOwed = true;
          return refuse(
            `Not sent: you have written ${limit}+ text replies to him with no photo, and he has never paid. Free talk is what he came for; more of it teaches him not to pay. ` +
              "Turn his own last words into the caption of ONE small paid single (send_photo kind paid, small and easy, priced for him): call send_photo NOW, before any send_reply, with your line as its caption. Only if it is refused, send_reply with words. " +
              "If he said his card or payment does not work, give one concrete help (add or change the card in Fanvue settings, try the app) and do not send a new offer; keep the text short and do not continue explicit talk for free. " +
              "If he has said no to a small unlock, send_reply again with one short plain line.",
          );
        }
      }
    }

    // Review, 24 Nov 2026 (12 hours): long warm chats with buyers got no priced step for 35-80 messages. Once, when about
    // buyerTalkMaxReplies of her messages went out since her newest paid one and a paid offer is allowed now, remind the model.
    // Review, 25 Nov 2026 ("we sell very less even to hot fans"): VIPs and fans who never paid get the reminder too, after 10 messages.
    if (!this.photoSent && !this.followUp && !this.thanks && !this.noSale && !this.research && !this.buyerTalkNudged && !this.freeTalkNudged) {
      const limit = this.rules.buyerTalkMaxReplies ?? 10;
      const chat = await this.readChat(SALES_HISTORY_MESSAGES).catch(() => null);
      const notesNow = chat ? await api.getNotes(fanUuid).catch(() => null) : null;
      if (chat && notesNow != null && sincePaidRun(chat, fanUuid) >= limit && buyerNudgeDue(notesNow, this.now())) {
        const insights = await api.getFanInsights(fanUuid).catch(() => null);
        const history = await this.#history(chat);
        history.paymentHold = paymentHold(notesNow, this.now());
        history.priceAnchorUsd = priceAnchorUsd(insights);
        const spentBefore = (insights?.spending?.total?.netTotal ?? 0) > 0 || history.bought > 0;
        if (!photoRefusal("pack", history, this.now(), this.rules.minPriceUsd, this.rules, false)) {
          this.buyerTalkNudged = true;
        this.offerOwed = true;
          await api.putNotes(fanUuid, withBuyerNudge(notesNow, this.now())).catch(() => {});
          const step = spentBefore
            ? "one priced step priced for him: send_photo kind paid or send_ppv_pack with a personal caption made of his own words (for a past tipper the tip line fits too)"
            : history.freePhotos > 0
              ? "his small, easy first unlock: send_photo kind paid, a cheap single, with his own words as the caption"
              : "a free photo first (send_photo kind free), so the paid one can follow on his reaction";
          return refuse(
            `Not sent yet: you have written ${limit}+ messages to him since your last priced offer and the chat is still only words. Heat that is not turned into a sale now cools off. ` +
              `If he is warm (flirting, a compliment on your looks or body, anything sexual, "I want you", "I miss you", asking about you with interest), send ${step} NOW, before any send_reply, with your line as its caption. Only if the photo is refused, send_reply with words. ` +
              "If he is sad, worried, tired or saying goodnight, just call send_reply again with your line and stay warm.",
          );
        }
      }
    }

    // Sales history, 27 Nov 2026: after a purchase she leads with reactions and teasing, not an interview. Refused once.
    if (!this.interviewNudged && !this.thanks && postBuyInterview(latest, fanUuid, this.now(), text)) {
      this.interviewNudged = true;
      return refuse(
        "Not sent: he bought from you in the last hours and your last two lines to him were questions. A third reads like an interview " +
          "(22 Nov 2026: the top spender wrote \"Repetitive questions and behavior...\" and stopped opening the chat). Make this line a reaction, a tease or a short piece of your story with no question, and call send_reply again.",
      );
    }

    // Review, 26 Nov 2026: "no pressure / no rush / glad you're here" is refused once; the second try goes out so he is never left unanswered.
    if (!this.stockNudged && stockLine(text)) {
      this.stockNudged = true;
      return refuse("Not sent: drop \"no pressure\", \"no rush\", \"glad you're here\" and \"nema pritiska/žurbe\": they read like a template. Say the same in your own fresh words, or just ask him one specific thing about himself, and call send_reply again.");
    }

    // Review, 24 Nov 2026 (evening): a line that announces a photo while none has gone out. Refused twice at most, so he is never left unanswered.
    if (!this.photoSent && !this.thanks && !this.research && (this.announceRefusals ??= 0) < 2 && announcesPhoto(text)) {
      this.announceRefusals += 1;
      return refuse(
        "Not sent: your line announces a photo (\"evo ...\", \"look at this\") but no photo has gone out. Either send the photo first (send_photo, send_moment_photos, send_selfie or send_ppv_pack, " +
          "with your words as its caption) and then send_reply only if you still need a line, or rewrite this line without announcing or promising any picture. If the photo is refused, answer in words only.",
      );
    }

    // Never repeat a line she already sent him, however long ago (owner, 14 Nov 2026: the same riddle twice, he noticed).
    if ((this.repeatRefusals ??= 0) < 3) {
      const earlier = await this.readChat(SALES_HISTORY_MESSAGES).catch(() => []);
      const again = repeatedLine(text, earlier.filter((m) => m.sender.uuid !== fanUuid));
      if (again) {
        this.repeatRefusals += 1;
        return refuse(
          `Not sent: you already said "${again.clause}" to him earlier in this chat (${again.at}). Never repeat a riddle, question, joke or line. ` +
            "Read older messages with read_chat (count 200) and write something new that answers what he just said.",
        );
      }
    }

    // Owner, 21 Nov 2026: a voice fan gets his short lines as audio. At most 2-3 words; a longer reply is sent back once to be
    // shortened, then goes out as text so he is never left unanswered. If Wiro or the upload fails, the same words go out as text.
    if (this.voice && !this.research) {
      if (wordCount(spokenText(text)) > MAX_VOICE_WORDS) {
        if (!this.voiceNudged) {
          this.voiceNudged = true;
          return refuse(`Not sent: he gets voice notes, so your reply must be only ${MAX_VOICE_WORDS} words or fewer in Serbian (for example "gde si bre", "šta mi radiš"), with his name if you know it. Shorten it and send_reply again.`);
        }
      } else if (await this.#sendVoice(text)) {
        await api.putNotes(fanUuid, withReplyCount(await api.getNotes(fanUuid))).catch(() => {});
        return ok("Sent as a voice note.");
      }
    }

    const [first, ...rest] = splitReply(text);
    await this.#sendPart(first);
    for (const part of rest) {
      await this.#wait(typingDelayMs(part));
      // He wrote or someone answered during the pause: the rest is out of date.
      if (!this.sentUuid || !stillNewest(await api.fetchMessages(fanUuid), this.sentUuid)) break;
      await this.#sendPart(part);
    }
    await api.putNotes(fanUuid, withReplyCount(await api.getNotes(fanUuid))).catch(() => {});
    return ok("Sent.");
  }

  /** Speaks the line, stores it as a voice note and sends it. Returns false (nothing sent) when any step fails. */
  async #sendVoice(text) {
    const spoken = spokenText(text);
    if (!spoken) return false;
    try {
      const bytes = await this.speakFn(spoken);
      const mediaUuid = await this.api.uploadAudio(voiceName(bytes), "voice.mp3", bytes);
      await this.api.sendVoice(this.fanUuid, mediaUuid);
    } catch (err) {
      console.error(`voice failed${err?.status ? `: ${err.status}` : ""}`); // fixed text, never the line
      return false;
    }
    const newest = (await this.api.fetchMessages(this.fanUuid).catch(() => []))[0];
    this.sentUuid = newest && newest.sender.uuid !== this.fanUuid ? newest.uuid : undefined;
    this.replied = true;
    return true;
  }

  /** Sends one message and marks the job replied. The newest message anchors the follow-up; if this read fails there is simply none. */
  async #sendPart(text) {
    await this.api.sendText(this.fanUuid, withTypo(text));
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
      .then((messages) => {
        const hers = messages.filter((m) => m.sender.uuid !== this.fanUuid);
        // Owner, 26 Nov 2026: a paid photo he never bought was never unlocked: "locked" (not seen) unless he got it some other way.
        const open = new Set(hers.flatMap((m) => (m.pricing && !m.purchasedAt ? (m.mediaPreviewUuid ? [m.mediaPreviewUuid] : []) : m.mediaUuids ?? [])));
        this.#locked = new Set(hers.flatMap((m) => (m.pricing && !m.purchasedAt ? m.mediaUuids ?? [] : [])).filter((u) => !open.has(u)));
        return new Set(hers.flatMap((m) => m.mediaUuids ?? []));
      })
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
    // Review, 26 Nov 2026: when the whole chat fits in what was read, his first message is when the talk started (no offer in its first
    // minutes). Automations sent on joining do not count: a fan joined at 08:05, first wrote at 12:43 and got $5 at 12:48.
    const his = messages.filter((m) => m.sender.uuid === this.fanUuid).map((m) => Date.parse(m.sentAt)).filter(Boolean);
    if (his.length && messages.length < SALES_HISTORY_MESSAGES) history.chatStartAt = Math.min(...his);
    history.freeHourLimit = this.vip ? VIP_FREE_PER_HOUR : FREE_PER_HOUR;
    history.vip = this.vip;
    history.thanks = this.thanks;
    history.payIntent = raisesPaying(newFanMessages(messages, this.fanUuid));
    const ever = await this.#everSentMedia();
    // A locked photo he never bought can be offered again as paid (owner, 26 Nov 2026), never free; salesHistory keeps the last 24 h blocked.
    if (ever) for (const u of ever) (this.#locked?.has(u) && !history.seen.has(u) ? history.offeredBefore : history.seen).add(u);
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
      // Owner, 24 Nov 2026 (one free photo per send): a set is used once all of it went to him (or the note names it, sets from
      // before this change); a set with some photos sent is "started" and is continued on the next send.
      .map((f, i) => {
        const sent = media[i].filter((u) => ever?.has(u)).length;
        return { ...f, uuids: media[i], started: sent > 0, used: usedNames.has(f.name.trim().toLowerCase()) || (media[i].length > 0 && sent >= media[i].length) };
      })
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
    if (!this.momentClaimNudged && momentClaim(text)) {
      this.momentClaimNudged = true;
      return refuse("Not sent: the caption says the photo was just taken or made for him. Never claim that: give it a few neutral, playful words (or his own words) and call it again.");
    }
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    if (!this.#anchorOk(messages)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    // Chat review, 14 Nov 2026: free sets in a row with no paid offer between them sold nothing. The purchase bonus and a tip thank-you always go.
    // Review, 25 Nov 2026: sets and selfies skipped the first-buyer free cap (a $0 fan got 6 free photos, no paid offer); same guard as send_photo now.
    const freeWhy = await this.#freeRefusal(messages);
    if (freeWhy) return refuse(`${freeWhy} No free set now.`);
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
      // Continue a set he has started; else stay with the scene of his latest set when one is left, else the oldest unused set.
      const last = sets.filter((s) => s.used && s.scene).at(-1);
      set = unused.find((s) => s.started) ?? (last && unused.find((s) => s.scene === last.scene)) ?? unused[0];
    }
    const photos = set.uuids.filter((u) => !ever.has(u));
    let count = Math.min(Math.max(Math.trunc(Number(args.count ?? 1)) || 1, 1), MOMENT_MAX_PER_SEND, photos.length);
    // Owner, 19 Nov 2026: the free gift after a purchase or a tip is one photo, never a whole set (a $4 unlock got 5 free photos, a tip got 4).
    if (this.thanks) count = 1;
    const uuids = photos.slice(0, count);
    if (!uuids.length) return refuse("That set has no photo left for him. Answer in words.");
    if (this.replied) await this.#wait(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    // Owner, 24 Nov 2026: the set stays open for him until every photo of it went out; then the note marks it used.
    const left = photos.length - uuids.length;
    if (!left) await api.putNotes(fanUuid, withUsedMomentSet(await api.getNotes(fanUuid), set.name)).catch(() => {});
    await this.#noteSent(uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.momentSent = true;
    this.momentSets++;
    return ok(`Sent ${uuids.length} ${uuids.length === 1 ? "photo" : "photos"} from the ${set.scene ?? "photo"} set. ${left ? `${left} more of that set ${left === 1 ? "is" : "are"} left for his next free photo.` : "That set is finished for him now."}`);
  }

  /**
   * Owner, 22 Nov 2026 (new vault folder "selfie"): one or two free selfies in one message, when a plain selfie fits. Never the same
   * photo to the same fan twice (everything sent to him is read back). Not in a follow-up. Free, no streak or first-buyer cap: it
   * is the everyday proof-of-her photo, and the folder is small.
   */
  /** Why a free photo (set or selfie) may not go out now, or null. The same caps as send_photo kind free; a thank-you always goes. */
  async #freeRefusal(messages) {
    if (this.thanks) return null;
    const history = await this.#history(messages);
    history.paymentHold = paymentHold(await this.api.getNotes(this.fanUuid).catch(() => null), this.now());
    history.freeStreakLimit = this.vip ? VIP_MAX_FREE_STREAK : MAX_FREE_STREAK;
    const insights = await this.api.getFanInsights(this.fanUuid).catch(() => null);
    return photoRefusal("free", history, this.now(), 0, this.rules, isFirstBuyer(insights, history, this.vip));
  }

  async #sendSelfie(args) {
    const { api, fanUuid } = this;
    if (this.followUp && !this.freeHook) return refuse("No photos in a follow-up. Stop here.");
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n")) return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    if (!this.momentClaimNudged && momentClaim(text)) {
      this.momentClaimNudged = true;
      return refuse("Not sent: the caption says the photo was just taken or made for him. Never claim that: give it a few neutral, playful words (or his own words) and call it again.");
    }
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    if (!this.#anchorOk(messages)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const freeWhy = await this.#freeRefusal(messages);
    if (freeWhy) return refuse(`${freeWhy} No free selfie now.`);
    const folders = (await Promise.resolve().then(() => api.listFolders()).catch(() => null))?.filter((f) => isSelfieFolder(f.name));
    if (!folders) return refuse("The selfie folder could not be read this time. Answer in words.");
    if (!folders.length) return refuse("No selfies are available. Answer in words.");
    const ever = await this.#everSentMedia();
    if (!ever) return refuse("His photo history could not be read this time. Send no selfie now; answer in words.");
    const lists = await Promise.all(
      folders.map((f) =>
        api
          .listFolderMedia(f.name)
          .then((list) => list.filter((m) => m.status === "ready" && m.mediaType === "image").map((m) => m.uuid))
          .catch(() => []),
      ),
    );
    const bag = [...new Set(lists.flat())].filter((u) => !ever.has(u));
    if (!bag.length) return refuse("He already had every selfie. Send none: answer in words, without promising a photo later.");
    const count = Math.min(Math.max(Math.trunc(Number(args.count)) || 1, 1), SELFIES_PER_REPLY, bag.length);
    const uuids = [];
    while (uuids.length < count && bag.length) uuids.push(bag.splice(Math.floor(this.random() * bag.length), 1)[0]);
    if (this.replied) await this.#wait(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    await this.#noteSent(uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(`Sent ${uuids.length} selfie${uuids.length > 1 ? "s" : ""}. ${bag.length ? "" : "That was the last unseen selfie for him."}`.trim());
  }

  /**
   * Owner, 19 Nov 2026 ("when he tips we can send ppv photo/s for free because he tipped us"): the reply to a tip may carry
   * 1 to 3 unseen photos from the paid stock, free, in one message. Not for purchases, follow-ups or after a refund.
   */
  async #sendTipPhotos(args) {
    const { api, fanUuid } = this;
    if (!this.tipGift) return refuse("Only in the reply to a tip. Stop here.");
    if (this.followUp) return refuse("No photos in a follow-up. Stop here.");
    if (this.noSale) return refuse("He is sold nothing after a refund or chargeback. Stop here.");
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n")) return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    const count = Math.min(Math.max(Math.trunc(Number(args.count)) || 1, 1), 3);
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    if (!this.#anchorOk(messages)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = await this.#history(messages);
    const pool = await this.#getPool();
    const left = pool ? paidCandidates(pool, history, this.vip) : [];
    if (!left.length) return refuse("No unseen paid photo is left for him. Send one free photo with send_photo kind free instead, or words only.");
    const bag = [...left];
    const uuids = [];
    while (uuids.length < count && bag.length) uuids.push(bag.splice(Math.floor(this.random() * bag.length), 1)[0].uuid);
    if (this.replied) await this.#wait(typingDelayMs(text));
    await api.sendPhotos(fanUuid, text, uuids);
    await this.#noteSent(uuids);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(`Sent ${uuids.length} paid-stock photo${uuids.length > 1 ? "s" : ""} for free as the answer to his tip.`);
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
    if (!this.momentClaimNudged && momentClaim(text)) {
      this.momentClaimNudged = true;
      return refuse("Not sent: the caption says the photo was just taken or made for him. Never claim that: give it a few neutral, playful words (or his own words) and call it again.");
    }
    const paidCaption = paidCaptionProblem(text);
    if (paidCaption) return refuse(paidCaption);
    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    if (!this.#anchorOk(messages)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    const history = await this.#history(messages);
    history.paymentHold = paymentHold(await api.getNotes(fanUuid), this.now());
    const firstBuyer = isFirstBuyer(await api.getFanInsights(fanUuid).catch(() => null), history, this.vip);
    // Same waiting time as a single paid photo (no open-offer limit since 19 Nov 2026); never a pack as his first offer.
    const refusal = photoRefusal("pack", history, this.now(), rules.minPriceUsd, rules, firstBuyer) ?? packRefusal(history, priceUsd);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const pack = pool && pickPack(pool, history, count, args.nude === true, this.random, this.vip || history.bought > 0);
    if (!pack) return refuse("Not enough unseen paid photos or previews for him. Send no pack: try send_photo kind paid, and if that is refused too, follow \"Out of paid photos\" (free photo if he wants photos, ready_for_offer).");

    if (this.replied) await this.#wait(typingDelayMs(text));
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
    const kind = args.kind === "paid" ? "paid" : "free";
    if (this.followUp && !(this.freeHook && kind === "free"))
      return refuse(this.freeHook ? "No paid photo before he has written: one free photo or selfie at most. Stop here." : "No photos in a follow-up. Stop here.");
    if (this.noSale && kind === "paid") return refuse("He is sold nothing after a refund or chargeback: no paid photo. Stop here.");
    if (this.thanks && kind === "paid") return refuse("No paid photo in a thank-you for his tip: the next offer waits until he flirts again. Stop here.");
    const priceUsd = args.price_usd === undefined ? undefined : Number(args.price_usd);
    if (isHandedOver(await api.getNotes(fanUuid), this.now())) return refuse("This chat is with a person. Stop here.");
    const gate = await this.gate();
    if (!gate.ok) return refuse(gate.reason ?? "Not allowed now. Stop here.");
    const text = finalText(String(args.text ?? ""));
    if (!text || text.length > 200 || text.includes("\n"))
      return refuse("Refused: one short line, at most 200 characters, no links, no mention of AI.");
    if (!this.momentClaimNudged && momentClaim(text)) {
      this.momentClaimNudged = true;
      return refuse("Not sent: the caption says the photo was just taken or made for him. Never claim that: give it a few neutral, playful words (or his own words) and call it again.");
    }
    const paidCaption = kind === "paid" ? paidCaptionProblem(text) : null;
    if (paidCaption) return refuse(paidCaption);

    const messages = await this.readChat(SALES_HISTORY_MESSAGES);
    if (!this.#anchorOk(messages)) {
      this.wroteAgain = true;
      return refuse("The chat changed. Send nothing more. Stop here.");
    }
    // Chat review, 24 Nov 2026: "ovu sam ti sacuvala za sad" went out as a text and then again as the photo's caption.
    if (!this.captionNudged) {
      const again = repeatedLine(text, messages.filter((m) => m.sender.uuid !== fanUuid));
      if (again) {
        this.captionNudged = true;
        return refuse(`Not sent: the caption repeats "${again.clause}", which you already sent him. Give the photo a different caption of a few words (or an emoji) and call send_photo again.`);
      }
    }
    const history = await this.#history(messages);
    if (this.thanks) history.freeStreak = history.freeLastHour = 0; // the thank-you photo for a tip or purchase always goes
    history.paymentHold = this.thanks ? null : paymentHold(await api.getNotes(fanUuid), this.now()); // a tip or purchase means he can pay
    history.freeStreakLimit = this.vip ? VIP_MAX_FREE_STREAK : MAX_FREE_STREAK;
    const insights = await api.getFanInsights(fanUuid).catch(() => null);
    history.priceAnchorUsd = priceAnchorUsd(insights);
    const firstBuyer = isFirstBuyer(insights, history, this.vip);
    const refusal = photoRefusal(kind, history, this.now(), priceUsd, rules, firstBuyer);
    if (refusal) return refuse(refusal);
    const pool = await this.#getPool();
    const photo = pool && pickPhoto(pool, kind, history, args.nude === true, this.random, this.vip || history.bought > 0);
    if (!photo)
      return refuse(
        kind === "paid"
          ? "No unseen paid photo is left for him. Follow \"Out of paid photos\": call ready_for_offer, and if he asked for photos send a free one with send_photo kind free instead."
          : "No unseen free photo is left for him either. Send no photo; call ready_for_offer and answer him in words.",
      );

    if (this.replied) await this.#wait(typingDelayMs(text));
    await api.sendPhoto(fanUuid, text, photo, kind === "paid" ? priceUsd * 100 : undefined);
    await this.#noteSent([photo]);
    const newest = (await api.fetchMessages(fanUuid).catch(() => []))[0];
    if (newest && newest.sender.uuid !== fanUuid) this.sentUuid = newest.uuid;
    this.replied = true;
    this.photoSent = true;
    return ok(kind === "paid" ? `Paid photo sent at $${priceUsd}.` : "Free photo sent.");
  }
}
