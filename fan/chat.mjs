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

// A tip shows as [tip] so Claude sees it even when he typed nothing with it.
const messageText = (m) =>
  m.type === "TIP" ? (m.text ? `${m.text} [tip]` : "[tip]") : (m.text ?? (m.hasMedia ? "[slika]" : ""));

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

/** Readable chat for Claude, oldest first. */
export function formatChat(newestFirst, fanUuid, now) {
  return [...newestFirst]
    .reverse()
    .filter(messageText)
    .map((m) => (m.sender.uuid === fanUuid ? `Fan: ${messageText(m)}` : `Andrea: ${ownLine(m, now)}`))
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

const MAX_REPLY_PARTS = 3;

/** Each line goes out as its own message, like someone texting. Anything past the limit stays on the last one. */
export function splitReply(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const rest = lines.slice(MAX_REPLY_PARTS - 1).join(" ");
  return rest ? [...lines.slice(0, MAX_REPLY_PARTS - 1), rest] : lines;
}

/** The pause before the next part of a reply: about as long as typing it, at most 8 seconds. */
export const typingDelayMs = (text) => Math.min(1500 + text.length * 60, 8000);

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
export const isHandedOver = (notes) => splitNotes(notes).own.split("\n").some((line) => line.startsWith(STOP_LINE));

const withOwn = (notes, own) => mergeNotes(own, splitNotes(notes).memory);

export function withStopLine(notes, reason, when) {
  if (isHandedOver(notes)) return notes ?? "";
  const why = STOP_REASONS[reason] ?? "he needs a person";
  const line = `${STOP_LINE}: ${why} (${when}). Answer him, then delete this line to give the chat back to the bot.`;
  const { own } = splitNotes(notes);
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
