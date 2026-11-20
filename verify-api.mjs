// Exercises the production adapters with synthetic inputs and one local tool.
import assert from "node:assert/strict";
import { runAgent, runFilter } from "./fan/claude.mjs";
import { startToolServer } from "./fan/mcp.mjs";
import { classifyPhoto } from "./fan/vision.mjs";

const schema = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["safe", "blocked"] } },
  required: ["verdict"],
  additionalProperties: false,
};
const filter = { model: "claude-haiku-5-5", system: "Say safe for HELLO and blocked for BLOCK.", schema };
const models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];
const apiHeaders = { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };

async function checkModels() {
  for (const model of models) {
    const response = await fetch(`https://api.anthropic.com/v1/models/${model}`, {
      headers: apiHeaders,
    });
    if (!response.ok) throw new Error(`claude failed: API model lookup returned ${response.status} for ${model}`);
  }
  console.log("API model access verified");
}

async function checkGeneration() {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { ...apiHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      model: filter.model, max_tokens: 128, messages: [{ role: "user", content: "Return the word safe." }],
    }),
  });
  if (response.ok) {
    await response.body?.cancel();
    console.log("API generation verified");
    return;
  }
  // This fixed probe contains no application, chat or tool data.
  const body = await response.json().catch(() => ({}));
  const limit = String(body?.error?.message ?? "").match(/\bAPI usage limits\b[^\r\n]*?\b(\d{4}-\d{2}-\d{2} at \d{2}:\d{2} UTC)\b/i);
  const detail = limit ? `API usage limit reached, reported reset ${limit[1]}` : `API generation returned HTTP ${response.status}`;
  throw new Error(`claude failed: ${detail}`);
}

async function checkFilter() {
  for (const [prompt, expected] of [["HELLO", "safe"], ["BLOCK", "blocked"]]) {
    assert.equal((await runFilter({ ...filter, prompt })).verdict, expected);
  }
  console.log("API filter verified");
}

async function checkTools() {
  let calls = 0;
  const tool = { name: "record_probe", description: "Record a synthetic test result.", inputSchema: { type: "object" } };
  const server = await startToolServer({
    async call(name) {
      if (name !== tool.name) return { text: "Unexpected tool", isError: true };
      calls++;
      return { text: "Probe recorded" };
    },
  }, [tool]);
  try {
    for (const model of models) {
      calls = 0;
      await runAgent({
        model,
        system: "Call record_probe exactly once, then stop.",
        prompt: "Run the synthetic probe now.",
        toolNames: [tool.name],
        mcpUrl: server.url,
        mcpKey: server.key,
      });
      assert.equal(calls, 1);
      console.log(`API reply tool verified for ${model}`);
    }
  } finally {
    server.close();
  }
}

async function checkPhoto() {
  const url = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAQABAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQABP/aAAwDAQACEQMRAD8A8nooor+uD+ZwooooAKKKKACiiigD/9Dyeiiiv64P5nPvXwd4O8I3XhHRLm50OxlmlsbZ3d7aJmZmiUkklckk8kmuj/4QjwX/ANADT/8AwFi/+Jo8Ef8AIl6B/wBg+1/9FLXUV/gZxdxdm0c2xcY4uokqk/ty/mfmf6F5Nk2DeDot0Y/DH7K7LyOX/wCEI8F/9ADT/wDwFi/+Jo/4QjwX/wBADT//AAFi/wDia6iivnv9cc3/AOgyp/4HL/M9L+xcH/z5j/4Cv8j8v6KKK/6FD/OI/9Hyeiiiv64P5nP0Y8Ef8iXoH/YPtf8A0UtdRXL+CP8AkS9A/wCwfa/+ilrqK/56+Mf+RvjP+vk//Smf6O5L/udH/DH8kFFFFfNnpn5f0UUV/wBHB/mef//S8nooor+uD+ZwooooAKKKKACiiigD/9k=";
  const photo = await classifyPhoto({ messageMedia: async () => ({ variants: [{ url }] }) }, "fixture", {
    uuid: "fixture", mediaUuids: ["fixture"],
  });
  assert.ok(photo?.kind);
  console.log("API photo classification verified");
}

for (const [name, check] of [["models", checkModels], ["generation", checkGeneration], ["filter", checkFilter], ["reply tools", checkTools], ["photo", checkPhoto]]) {
  try {
    await check();
  } catch (error) {
    const detail = error.message.startsWith("claude failed:") ? error.message : "unexpected result";
    console.error(`API check failed (${name}): ${detail}`);
    process.exitCode = 1;
    if (name === "generation") break;
  }
}
