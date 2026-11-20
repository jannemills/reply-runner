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

try {
  for (const [prompt, expected] of [["HELLO", "safe"], ["BLOCK", "blocked"]]) {
    assert.equal((await runFilter({ ...filter, prompt })).verdict, expected);
  }
  console.log("API filter verified");

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
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]) {
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

  const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXH0AAAAASUVORK5CYII=";
  const photo = await classifyPhoto({ messageMedia: async () => ({ variants: [{ url }] }) }, "fixture", {
    uuid: "fixture", mediaUuids: ["fixture"],
  });
  assert.ok(photo?.kind);
  console.log("API photo classification verified");
} catch (error) {
  console.error(error.message.startsWith("claude failed:") ? error.message : "API verification failed");
  process.exitCode = 1;
}
