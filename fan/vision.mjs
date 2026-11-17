// Looks at the photo a fan sent so the reply can match what is in it (owner, 17 Nov 2026: a blind "you look beautiful"
// went to a fan's non-selfie). Only a fixed category and one neutral phrase come back; the image never leaves this job.
// Never print the image, its URL or the description: this log is public.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "./claude.mjs";

export const PHOTO_KINDS = ["face_selfie", "body_clothed", "explicit_nude", "object_or_place", "pet_or_animal", "screenshot_or_text", "meme_or_other"];

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: PHOTO_KINDS }, note: { type: "string", maxLength: 80 } },
  required: ["kind", "note"],
};

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
    const dir = mkdtempSync(join(tmpdir(), "look-"));
    writeFileSync(join(dir, "photo.jpg"), Buffer.from(await res.arrayBuffer()));
    const result = await runClaude(
      "Read the file photo.jpg in the current folder and classify it. kind: face_selfie = a clear picture of a person's face or a normal selfie; body_clothed = a person's body, clothed; explicit_nude = nudity or genitals; object_or_place = an object, food, car, landscape, room; pet_or_animal; screenshot_or_text; meme_or_other. note: at most 12 neutral words saying what it is, with no explicit detail.",
      ["--model", "claude-sonnet-5-5", "--tools", "Read", "--allowedTools", "Read", "--max-turns", "3", "--json-schema", JSON.stringify(SCHEMA), "--system-prompt", "You label images for a chat assistant. Answer only with the requested JSON."],
      "low",
      dir,
    );
    const a = result.structured_output;
    return PHOTO_KINDS.includes(a?.kind) ? { kind: a.kind, note: String(a.note ?? "").slice(0, 80) } : null;
  } catch {
    return null;
  }
}
