// Voice messages (owner, 21 Nov 2026): for a fan on VOICE_FAN_UUIDS her short Serbian lines go out as audio, not words.
// Wiro (ElevenLabs eleven-v4) makes the speech, Fanvue stores it as a voice note. The voice is fixed on purpose: always the same
// voice, the same delivery tags, the same settings and the same seed, so every audio sounds like the same woman.
import { createHash, createHmac } from "node:crypto";

const WIRO = "https://api.wiro.ai/v1";
export const VOICE = {
  voice: "sarah",                // owner, 7 Nov 2026: our voice on every Wiro ElevenLabs model
  languageCode: "sr",            // Serbian only; an English fan gets text
  outputFormat: "mp3_44100_128",
  stability: "0.5",
  similarityBoost: "0.75",
  seed: "7",                     // fixed, so the delivery does not drift between audios
  tags: "[softly] [playfully] ",  // owner, 21 Nov 2026: "light and womanish"; the same tags on every line
};
export const MAX_VOICE_WORDS = 3;
const POLL_MS = 1500;
const WIRO_MAX_MS = 60_000;

/** The line as it is spoken: no emoji or symbols. */
export const spokenText = (text) => String(text).replace(/[^\p{L}\p{N}\s,.!?'-]/gu, "").replace(/\s+/g, " ").trim();

/** Words of a short line, for the 2-3 word limit. */
export const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

let lastNonce = 0;
function wiroHeaders(key, secret) {
  // The nonce must be unique per request; two jobs can start in the same second.
  lastNonce = Math.max(lastNonce + 1, Date.now());
  const nonce = String(lastNonce);
  const signature = createHmac("sha256", key).update(secret + nonce).digest("hex");
  return { "Content-Type": "application/json", "x-api-key": key, "x-nonce": nonce, "x-signature": signature, "User-Agent": "curl/8.0" };
}

/** Speaks `text` and returns the mp3 bytes. Throws on any failure; the message names the step only. */
export async function speak(text, { key = process.env.WIRO_API_KEY, secret = process.env.WIRO_API_SECRET, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!key || !secret) throw new Error("wiro not configured");
  const post = async (path, body) => {
    const res = await fetchFn(`${WIRO}${path}`, { method: "POST", headers: wiroHeaders(key, secret), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`wiro ${path.split("/")[1]} failed: ${res.status}`);
    return res.json();
  };
  const run = await post("/Run/elevenlabs/eleven-v4", {
    prompt: `${VOICE.tags}${text}`,
    voice: VOICE.voice,
    outputFormat: VOICE.outputFormat,
    languageCode: VOICE.languageCode,
    timestamps: "false",
    applyTextNormalization: "auto",
    stability: VOICE.stability,
    similarityBoost: VOICE.similarityBoost,
    seed: VOICE.seed,
  });
  if (!run.result || !run.taskid) throw new Error("wiro submit refused");
  const started = Date.now();
  for (;;) {
    const detail = await post("/Task/Detail", { taskid: run.taskid });
    const task = detail.tasklist?.[0];
    if (task?.status === "task_cancel") throw new Error("wiro task cancelled");
    if (task?.status === "task_postprocess_end") {
      const url = task.outputs?.[0]?.url;
      if (!url) throw new Error("wiro gave no audio");
      const audio = await fetchFn(url, { headers: { "User-Agent": "curl/8.0" } });
      if (!audio.ok) throw new Error(`wiro download failed: ${audio.status}`);
      return Buffer.from(await audio.arrayBuffer());
    }
    if (Date.now() - started > WIRO_MAX_MS) throw new Error("wiro timed out");
    await sleep(POLL_MS);
  }
}

/** A short stable name for the media record; never the text. */
export const voiceName = (bytes) => `voice ${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}`;
