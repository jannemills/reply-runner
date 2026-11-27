// Owner, 15 Nov 2026: about one message in eight carries ONE tiny, human typo: an extra character
// (a doubled letter or a neighbouring key) or one wrong character (a neighbouring key).
// Never in prices, numbers, links, @names or short messages; only inside one ordinary word, never its first letter.
// fv-17 review, 27 Nov 2026: one in eight read as a bot to new fans (two asked if she is AI); now one in twenty.
export const TYPO_CHANCE = 1 / 20;

const NEAR = {
  q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol",
  a: "qsz", s: "adwx", d: "sfec", f: "dgrv", g: "fhtb", h: "gjyn", j: "hkum", k: "jlio", l: "kop",
  z: "asx", x: "zsc", c: "xdv", v: "cfb", b: "vgn", n: "bhm", m: "nj",
};

export function withTypo(text, rand = Math.random, chance = TYPO_CHANCE) {
  if (typeof text !== "string" || text.length < 18 || rand() >= chance) return text;
  if (/[$€£0-9@#]|https?:|www\.|\.com|\.bio/i.test(text)) return text;
  // Review, 24 Nov 2026: typos landed in how-to-pay help ("the next one you umlock"). Never in a line about paying or unlocking.
  if (/fanvue|unlock|settings|card|payment|pay\b|bank|kartic|podesav|otklju|otkljuc|bankomat|plati|placa|uplat|aplikacij/i.test(text)) return text;
  const words = [...text.matchAll(/\p{L}{4,}/gu)];
  if (!words.length) return text;
  const w = words[Math.floor(rand() * words.length)];
  const chars = [...w[0]];
  const i = 1 + Math.floor(rand() * (chars.length - 1)); // never the first letter
  const near = NEAR[chars[i].toLowerCase()];
  const nb = near ? near[Math.floor(rand() * near.length)] : chars[i];
  if (rand() < 0.5) chars.splice(i + 1, 0, rand() < 0.5 ? chars[i] : nb); // extra character
  else chars[i] = nb; // wrong character
  const typed = chars.join("");
  return typed === w[0] ? text : text.slice(0, w.index) + typed + text.slice(w.index + w[0].length);
}
