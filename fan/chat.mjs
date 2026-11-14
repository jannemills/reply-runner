// Reading and writing a chat: how a conversation looks to Claude, what may be sent, and the bot's notes in Fanvue.

const isAutomatedOrBroadcast = (m) => m.type === "BROADCAST" || m.type.startsWith("AUTOMATED");

/** The newest message that a person wrote. Automations and mass messages don't count as answers. */
export const newestPersonal = (newestFirst) => newestFirst.find((m) => !isAutomatedOrBroadcast(m));

/** True when the newest personal message came from the fan. */
export const needsReply = (newestFirst, fanUuid) => newestPersonal(newestFirst)?.sender.uuid === fanUuid;

/** True when this message is still the newest of any kind: he, a person, an automation or a mass message all end the wait. */
export const stillNewest = (newestFirst, uuid) => newestFirst[0]?.uuid === uuid;

/** What a message of hers was, in the Worker's fixed words, so a reaction to it can be named without its text. */
export function reactedTo(m) {
  if (!m.hasMedia) return "a message";
  if (!m.pricing) return "a photo";
  return m.purchasedAt ? "a paid photo he bought" : "a paid photo he has not opened";
}

/** True when a person answered him after `at` (ms): a message of hers, not an automation or mass message, sent later. */
export const answeredSince = (newestFirst, fanUuid, at) =>
  newestFirst.some((m) => !isAutomatedOrBroadcast(m) && m.sender.uuid !== fanUuid && Date.parse(m.sentAt) > at);

/** A free photo from her (not automated) sent after `at`: the gift for a purchase already went out. */
export const freePhotoSince = (newestFirst, fanUuid, at) =>
  newestFirst.some((m) => !isAutomatedOrBroadcast(m) && m.sender.uuid !== fanUuid && m.hasMedia && !m.pricing && Date.parse(m.sentAt) > at);

// A tip shows as [tip] so Claude sees it even when he typed nothing with it.
// Chat review, 14 Nov 2026: a fan's photo with a caption showed only the caption, so the bot answered his selfie with "i wanna see you".
const messageText = (m) =>
  m.type === "TIP" ? (m.text ? `${m.text} [tip]` : "[tip]") : m.hasMedia ? (m.text ? `${m.text} [slika]` : "[slika]") : (m.text ?? "");

/** Her line, with what she attached, so Claude knows a photo or paid photo went out even when it had a caption. */
function ownLine(m, now) {
  if (!m.hasMedia) return m.text ?? "";
  const cents = m.pricing?.USD?.price;
  const price = cents != null ? ` $${cents / 100}` : "";
  const mins = now ? Math.max(0, Math.round((now - Date.parse(m.sentAt)) / 60_000)) : null;
  const age = mins == null ? "" : mins < 120 ? `, sent ${mins} min ago` : mins < 2880 ? `, sent ${Math.round(mins / 60)} h ago` : `, sent ${Math.round(mins / 1440)} days ago`;
  const media = !m.pricing ? "[slika]" : m.purchasedAt ? `[paid photo${price}, he bought it]` : `[paid photo${price}, not opened${age}]`;
  return m.text ? `${m.text} ${media}` : media;
}

/** A message Andrea typed herself: a plain one-to-one message sent from no app (owner, 6 Nov 2026: her style is the one to copy). */
const typedByHer = (m) => m.type === "SINGLE_RECIPIENT" && m.appUuid === null;

/** When Andrea last typed in this chat herself (ms), or 0. Chat review, 14 Nov 2026: the bot answered seconds after her. */
export const herLastTypedAt = (newestFirst, fanUuid) => {
  const m = newestFirst.find((x) => x.sender.uuid !== fanUuid && typedByHer(x));
  return m ? Date.parse(m.sentAt) || 0 : 0;
};

/**
 * How many separate times she wrote since his last message (personal messages only; parts sent within 10 minutes count
 * once). Chat review, 14 Nov 2026: up to five check-ins in a row went unanswered.
 */
export function unansweredRuns(newestFirst, fanUuid) {
  let runs = 0;
  let prev = null;
  for (const m of newestFirst) {
    if (isAutomatedOrBroadcast(m)) continue;
    if (m.sender.uuid === fanUuid) break;
    const at = Date.parse(m.sentAt) || 0;
    if (prev == null || prev - at > 10 * 60_000) runs++;
    prev = at;
  }
  return runs;
}

/** Readable chat for Claude, oldest first. */
export function formatChat(newestFirst, fanUuid, now) {
  return [...newestFirst]
    .reverse()
    .filter(messageText)
    .map((m) => (m.sender.uuid === fanUuid ? `Fan: ${messageText(m)}` : `${typedByHer(m) ? "Andrea (her own typing)" : "Andrea"}: ${ownLine(m, now)}`))
    .join("\n");
}

/** A research chat with a creator we follow: her paid media shows its price and whether it was unlocked. */
function creatorLine(m) {
  const kind = m.type && m.type !== "SINGLE_RECIPIENT" ? ` (${m.type.toLowerCase()})` : "";
  if (!m.hasMedia) return `${m.text ?? ""}${kind}`;
  const cents = m.pricing?.USD?.price;
  const media = cents == null ? "[free media]" : m.purchasedAt ? `[paid media $${cents / 100}, unlocked]` : `[paid media $${cents / 100}, locked]`;
  return `${m.text ? `${m.text} ` : ""}${media}${kind}`;
}

/** A research chat waits for us when its newest message of any kind is hers: her mass pitches count too (owner, 4 Nov 2026). */
export const researchNeedsReply = (newestFirst, creatorUuid) => newestFirst[0]?.sender.uuid === creatorUuid;

/** What she sent since our last message, mass messages included, oldest first. This is what the filter checks. */
export function newCreatorMessages(newestFirst, creatorUuid) {
  const lines = [];
  for (const m of newestFirst) {
    if (m.sender.uuid !== creatorUuid) break;
    if (m.text) lines.unshift(m.text);
  }
  return lines.join("\n");
}

export function formatResearchChat(newestFirst, creatorUuid) {
  return [...newestFirst]
    .reverse()
    .filter((m) => m.text || m.hasMedia)
    .map((m) => (m.sender.uuid === creatorUuid ? `Creator: ${creatorLine(m)}` : `You: ${m.text ?? "[media]"}`))
    .join("\n");
}

/** What the fan wrote since the last personal answer, oldest first. This is what the filter checks. */
export function newFanMessages(newestFirst, fanUuid) {
  const lines = [];
  for (const m of newestFirst) {
    if (isAutomatedOrBroadcast(m)) continue;
    if (m.sender.uuid !== fanUuid) break;
    if (messageText(m)) lines.unshift(messageText(m));
  }
  return lines.join("\n");
}

export const mentionsAi = (text) => /(^|[^\p{L}])(ai|a\.i\.|ej ?aj|vestack|veštačk)/iu.test(text);

/** The reply must never speak of a team, manager or assistant (same check as the Telegram auto-reply). */
export const mentionsTeam = (text) =>
  /(^|[^\p{L}])(team|tima|manager\p{L}*|staff|assistant\p{L}*|menad\p{L}*|asistent\p{L}*)([^\p{L}]|$)/iu.test(text);

const MAX_REPLY_CHARS = 600;

/** Final check on model output before anything is sent. Returns the text to send, or null. */
export function finalText(reply) {
  const text = reply.trim();
  if (!text || text.length > MAX_REPLY_CHARS) return null;
  if (/https?:\/\/|www\./i.test(text) || mentionsAi(text) || mentionsTeam(text)) return null;
  return text;
}

const plainWords = (text) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "dj").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/**
 * A line of this reply that she already sent this fan (owner, 14 Nov 2026: the same riddle went out twice, 2 hours apart, and he
 * said "to si vec pitala"; the 30 messages Claude reads and its notes had both lost the first one). Compared clause by clause,
 * ignoring case, accents and punctuation, so a new lead-in before an old question still counts. Short clauses are ignored.
 * Returns the repeated clause with the time she first sent it, or null.
 */
export function repeatedLine(reply, herEarlier) {
  const old = herEarlier.map((m) => ({ words: new Set(plainWords(m.text ?? "")), at: m.sentAt })).filter((m) => m.words.size >= 4);
  for (const clause of reply.split(/[\n.?!…]+/)) {
    const words = plainWords(clause);
    if (words.length < 4) continue;
    const hit = old.find((m) => words.filter((w) => m.words.has(w)).length / words.length >= 0.85);
    if (hit) return { clause: clause.trim(), at: hit.at };
  }
  return null;
}

const MAX_REPLY_PARTS = 3;

/** Each line goes out as its own message, like someone texting. Anything past the limit stays on the last one. */
export function splitReply(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const rest = lines.slice(MAX_REPLY_PARTS - 1).join(" ");
  return rest ? [...lines.slice(0, MAX_REPLY_PARTS - 1), rest] : lines;
}

/** The pause before the next part of a reply: about as long as a person needs to type it, at most 15 seconds (owner, 6 Nov 2026: parts seconds apart looked automated). */
export const typingDelayMs = (text) => Math.min(2500 + text.length * 90, 15000);

export function belgradeNow(ms) {
  return new Intl.DateTimeFormat("sr-Latn-RS", { timeZone: "Europe/Belgrade", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

const MEMORY_START = "--- andrea memory (auto) ---";
const MEMORY_END = "--- end andrea memory ---";
const MAX_NOTES_CHARS = 5000;

/** Fanvue keeps one note per fan. The bot's memory is a marked section; everything else is yours. */
export function splitNotes(notes) {
  const text = notes ?? "";
  const start = text.indexOf(MEMORY_START);
  const end = text.indexOf(MEMORY_END);
  if (start < 0 || end < start) return { own: text.trim(), memory: "" };
  const own = `${text.slice(0, start)}${text.slice(end + MEMORY_END.length)}`.trim();
  return { own, memory: text.slice(start + MEMORY_START.length, end).trim() };
}

/** The full note to save: your text untouched, then the new memory cut to whatever room is left. */
export function mergeNotes(notes, memory) {
  const { own } = splitNotes(notes);
  const clean = memory.replaceAll(MEMORY_START, "").replaceAll(MEMORY_END, "").trim();
  const prefix = own ? `${own}\n\n` : "";
  const room = MAX_NOTES_CHARS - prefix.length - MEMORY_START.length - MEMORY_END.length - 2;
  return `${prefix}${MEMORY_START}\n${clean.slice(0, Math.max(room, 0))}\n${MEMORY_END}`;
}

const STOP_LINE = "BOT STOPPED";
const COUNT_LINE = "Bot replies:";
const STOP_REASONS = {
  real: "he asked if she is real",
  meet: "he asked to meet",
  call: "he asked for a call",
  contact: "he asked for her contact",
  complaint: "he has a complaint",
  payment: "he has a payment or purchase problem",
  business: "he made a business proposal",
};

/** Only your part of the note counts, so nothing the bot writes as memory can start or stop it. */
// Owner, 10 Nov 2026: "we should be smart enough". A handed-over chat never waits more than this long: after it the line
// is ignored and the bot answers him itself. Lines without a stamp (older ones) count as handed over until deleted.
export const HAND_OVER_TTL_MS = 3 * 60 * 60 * 1000;
export const isHandedOver = (notes, now = Date.now()) =>
  splitNotes(notes).own.split("\n").some((line) => {
    if (!line.startsWith(STOP_LINE)) return false;
    const at = Number(/\[t=(\d+)\]/.exec(line)?.[1]);
    return !!at && now - at < HAND_OVER_TTL_MS; // owner, 12 Nov 2026: an old line without a stamp no longer blocks a chat forever
  });

// Chat review, 14 Nov 2026: a chat handed over for the same reason was handed over again every 3 hours, so nobody answered
// him for 8+ hours. After the 3 hours run out, the same reason is not handed over again for this long: the bot answers him.
export const HAND_OVER_REPEAT_MS = 24 * 60 * 60 * 1000;
export const handedOverBefore = (notes, reason, now = Date.now()) => {
  const why = STOP_REASONS[reason] ?? "he needs a person";
  return splitNotes(notes).own.split("\n").some((line) => {
    if (!line.startsWith(`${STOP_LINE}: ${why} (`)) return false;
    const at = Number(/\[t=(\d+)\]/.exec(line)?.[1]);
    return !!at && now - at < HAND_OVER_REPEAT_MS;
  });
};

const withOwn = (notes, own) => mergeNotes(own, splitNotes(notes).memory);

export function withStopLine(notes, reason, when, nowMs = Date.now()) {
  if (isHandedOver(notes, nowMs)) return notes ?? "";
  const why = STOP_REASONS[reason] ?? "he needs a person";
  const line = `${STOP_LINE}: ${why} (${when}) [t=${nowMs}]. Answer him, then delete this line to give the chat back to the bot (it gives itself back after 3 hours).`;
  const own = splitNotes(notes).own.split("\n").filter((l) => !l.startsWith(STOP_LINE)).join("\n");
  return withOwn(notes, own ? `${line}\n${own}` : line);
}

export function withReplyCount(notes) {
  const lines = splitNotes(notes).own.split("\n").filter((line) => line);
  const at = lines.findIndex((line) => line.startsWith(COUNT_LINE));
  const count = at < 0 ? 0 : Number(lines[at].slice(COUNT_LINE.length)) || 0;
  const line = `${COUNT_LINE} ${count + 1}`;
  if (at < 0) lines.push(line);
  else lines[at] = line;
  return withOwn(notes, lines.join("\n"));
}

// Owner, 13 Nov 2026: an "in the moment" folder is used once per fan. After one or more of its photos went to him, the whole
// folder is his "used" set and none of it is ever sent to him again. Kept in your part of his note, so it outlasts any chat window.
const MOMENT_LINE = "Moment sets used:";
const momentKey = (name) => String(name ?? "").trim().toLowerCase();

/** The "in the moment" folder names already used for him (lower case). */
export function usedMomentSets(notes) {
  const line = splitNotes(notes).own.split("\n").find((l) => l.startsWith(MOMENT_LINE));
  return new Set((line ? line.slice(MOMENT_LINE.length) : "").split("|").map(momentKey).filter(Boolean));
}

/** The note with this folder added to his used sets. */
export function withUsedMomentSet(notes, name) {
  const used = usedMomentSets(notes);
  used.add(momentKey(name));
  const lines = splitNotes(notes).own.split("\n").filter((l) => l && !l.startsWith(MOMENT_LINE));
  lines.push(`${MOMENT_LINE} ${[...used].join(" | ")}`);
  return withOwn(notes, lines.join("\n"));
}
