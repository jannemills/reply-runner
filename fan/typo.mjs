// Owner, 15 Nov 2026: about one message in eight carries one small, believable typo, the way a person typing fast does.
// Never in prices, numbers, links, @names or short messages; only inside one ordinary word, never its first letter.
export const TYPO_CHANCE = 1 / 8;

export function withTypo(text, rand = Math.random, chance = TYPO_CHANCE) {
  if (typeof text !== "string" || text.length < 18 || rand() >= chance) return text;
  if (/[$€£0-9@#]|https?:|www\.|\.com|\.bio/i.test(text)) return text;
  const words = [...text.matchAll(/\p{L}{5,}/gu)];
  if (!words.length) return text;
  const w = words[Math.floor(rand() * words.length)];
  const word = w[0];
  const chars = [...word];
  const kinds = [];
  for (let i = 1; i < chars.length - 1; i++) if (chars[i] === chars[i + 1]) kinds.push(["drop", i]);
  for (let i = 1; i < chars.length - 2; i++) if (chars[i] !== chars[i + 1]) kinds.push(["swap", i]);
  kinds.push(["double", 1 + Math.floor(rand() * (chars.length - 2))]);
  const pool = kinds.filter((k) => k[0] !== "double").length ? kinds.filter((k) => k[0] !== "double") : kinds;
  const [kind, i] = pool[Math.floor(rand() * pool.length)];
  if (kind === "drop") chars.splice(i, 1);
  else if (kind === "swap") [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  else chars.splice(i, 0, chars[i]);
  const typed = chars.join("");
  return typed === word ? text : text.slice(0, w.index) + typed + text.slice(w.index + word.length);
}
