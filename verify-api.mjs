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

async function checkModels() {
  for (const model of models) {
    const response = await fetch(`https://api.anthropic.com/v1/models/${model}`, {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    if (!response.ok) throw new Error(`claude failed: API model lookup returned ${response.status} for ${model}`);
  }
  console.log("API model access verified");
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
  const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXH0AAAAASUVORK5CYII=";
  const photo = await classifyPhoto({ messageMedia: async () => ({ variants: [{ url }] }) }, "fixture", {
    uuid: "fixture", mediaUuids: ["fixture"],
  });
  assert.ok(photo?.kind);
  console.log("API photo classification verified");
}

for (const [name, check] of [["models", checkModels], ["filter", checkFilter], ["reply tools", checkTools], ["photo", checkPhoto]]) {
  try {
    await check();
  } catch (error) {
    const detail = error.message.startsWith("claude failed:") ? error.message : "unexpected result";
    console.error(`API check failed (${name}): ${detail}`);
    process.exitCode = 1;
  }
}
