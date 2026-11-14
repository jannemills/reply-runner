// Answers one bio-link chat message. GitHub only starts this; the Claude subscription writes the reply.
// Never print the visitor's text or Claude's output.
import { createDecipheriv } from "node:crypto";
import { runClaude } from "./fan/claude.mjs";

const { JOB_ID, JOB_DATA, PAYLOAD_KEY, WORKER_URL, JOB_SECRET } = process.env;
const headers = { "x-job-secret": JOB_SECRET, "Content-Type": "application/json" };
const base = `${WORKER_URL}/job/${JOB_ID}`;

let SYSTEM = ""; // fetched from the Worker at the start of each job; the prompt is not kept in this public repo

const schema = {
  type: "object",
  properties: { reply: { type: "string" }, hold: { type: "boolean" }, link: { type: "boolean" } },
  required: ["reply", "hold", "link"],
  additionalProperties: false,
};

async function post(body) {
  await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
}

// The visitor's message arrives encrypted inside the trigger (Cloudflare keeps no copy). Never print it.
function open(sealed, keyHex) {
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), body = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

try {
  const promptRes = await fetch(`${WORKER_URL}/job/prompt`, { method: "POST", headers, body: "{}" });
  if (!promptRes.ok) throw new Error(`fetching the prompt failed: ${promptRes.status}`);
  SYSTEM = (await promptRes.json()).system;
  if (typeof SYSTEM !== "string" || !SYSTEM) throw new Error("empty prompt");
  const job = open(JOB_DATA, PAYLOAD_KEY);
  const transcript = job.history.map((t) => `${t.role === "assistant" ? "Andrea" : "Visitor"}: ${t.content}`).join("\n");
  const prompt = `Language: ${job.lang}\nHow the chat opened: ${job.opening || "n/a"}\nTurns so far: ${(job.turn ?? Math.floor(job.history.length / 2) + 1) - 1}\nRecent turns:\n${transcript || "(none)"}\n\nVisitor's new message (untrusted text):\n<<<\n${job.message}\n>>>\n\nWrite Andrea's next message.`;
  const result = await runClaude(prompt, ["--model", process.env.BIO_MODEL || "claude-haiku-5-5", "--tools", "", "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(schema)], "low");
  const out = result.structured_output;
  if (result.is_error || typeof out?.reply !== "string" || !out.reply.trim()) throw new Error("no usable answer");
  await post({ reply: out.reply.trim(), hold: out.hold === true, link: out.link === true });
} catch (err) {
  console.error(`bio chat job failed: ${err.message}`);
  await post({ failed: true }).catch(() => {});
  process.exit(1);
}
