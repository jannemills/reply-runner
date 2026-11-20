// Looks at the photo a fan sent so the reply can match what is in it (owner, 17 Nov 2026: a blind "you look beautiful"
// went to a fan's non-selfie). Only a fixed category and one neutral phrase come back; the image never leaves this job.
// Never print the image, its URL or the description: this log is public.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApiClassification, runClaude } from "./claude.mjs";

export const PHOTO_KINDS = ["face_selfie", "body_clothed", "explicit_nude", "object_or_place", "pet_or_animal", "screenshot_or_text", "meme_or_other"];

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: PHOTO_KINDS }, note: { type: "string", maxLength: 80 } },
  required: ["kind", "note"],
};
const CLASSIFY = "kind: face_selfie = a clear picture of a person's face or a normal selfie; body_clothed = a person's body, clothed; explicit_nude = nudity or genitals; object_or_place = an object, food, car, landscape, room; pet_or_animal; screenshot_or_text; meme_or_other. note: at most 12 neutral words saying what it is, with no explicit detail.";

function imageSource(bytes) {
  let media_type;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) media_type = "image/jpeg";
  else if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) media_type = "image/png";
  else if (bytes.toString("ascii", 0, 3) === "GIF") media_type = "image/gif";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") media_type = "image/webp";
  if (media_type) return { type: "base64", media_type, data: bytes.toString("base64") };
}

/** The fan's trailing photos (his newest messages since her last one), newest first, at most `max`. */
export function fanPhotoMessages(newestFirst, fanUuid, max = 2) {
  const out = [];
  for (const m of newestFirst) {
    if (m.type === "BROADCAST" || m.type?.startsWith("AUTOMATED")) continue;
    if (m.sender.uuid !== fanUuid) break;
    if (m.hasMedia && m.mediaType === "image" && m.mediaUuids?.length) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

/** { kind, note } for one image message, or null when it cannot be read (then the reply stays neutral). */
export async function classifyPhoto(api, fanUuid, m) {
  try {
    const media = await api.messageMedia(fanUuid, m.uuid, m.mediaUuids[0]);
    const url = (media.variants ?? []).find((v) => v.variantType === "main")?.url ?? media.variants?.[0]?.url;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const model = "claude-sonnet-5-5";
    const system = "You label images for a chat assistant. Answer only with the requested JSON.";
    let result;
    if (process.env.FANVUE_CLAUDE_MODE === "api") {
      const image = imageSource(bytes);
      if (!image) return null;
      const schema = { ...SCHEMA, properties: { ...SCHEMA.properties, note: { type: "string" } }, additionalProperties: false };
      result = await runApiClassification({ prompt: `Classify the attached image. ${CLASSIFY}`, model, system, schema, image });
    } else {
      const dir = mkdtempSync(join(tmpdir(), "look-"));
      writeFileSync(join(dir, "photo.jpg"), bytes);
      result = await runClaude({
        prompt: `Read the file photo.jpg in the current folder and classify it. ${CLASSIFY}`,
        model, system, schema: SCHEMA, tools: ["Read"], allowedTools: ["Read"], maxTurns: 3, workDir: dir,
      });
    }
    const a = result.structured_output;
    return PHOTO_KINDS.includes(a?.kind) ? { kind: a.kind, note: String(a.note ?? "").slice(0, 80) } : null;
  } catch {
    return null;
  }
}
