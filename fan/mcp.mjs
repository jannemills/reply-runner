// A tiny MCP server over HTTP on this machine only. Claude reaches the job's tools through it; nothing else is exposed.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** Handles one JSON-RPC message. Returns null for notifications, which get no answer. */
export async function handleMcp(rpc, tools, call) {
  if (rpc.id === undefined || rpc.id === null) return null;
  const answer = (result) => ({ jsonrpc: "2.0", id: rpc.id, result });
  switch (rpc.method) {
    case "initialize":
      return answer({
        protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "chat", version: "1.0.0" },
      });
    case "ping":
      return answer({});
    case "tools/list":
      return answer({ tools });
    case "tools/call": {
      const { text, isError } = await call(rpc.params?.name ?? "", rpc.params?.arguments ?? {});
      return answer({ content: [{ type: "text", text }], isError: !!isError });
    }
    default:
      return { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } };
  }
}

/**
 * Serves `jobTools` to the Claude process started by this job. Logs only fixed texts: never chat text, tokens or errors.
 * Returns { url, key, close }; requests without the key get a 404.
 */
export async function startToolServer(jobTools, tools) {
  const key = randomBytes(24).toString("hex");
  const call = async (name, args) => {
    try {
      const result = await jobTools.call(name, args);
      if (name === "send_reply" || result.isError) console.log(`tool ${name} ${result.isError ? "refused" : "ok"}: ${result.text.slice(0, 60)}`);
      return result;
    } catch (err) {
      console.error(`tool ${name} failed${err?.status ? `: ${err.status}` : ""}`);
      return { text: "That did not work. Stop here.", isError: true };
    }
  };
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.headers["x-tool-key"] !== key) return res.writeHead(404).end();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const answer = await handleMcp(JSON.parse(body), tools, call);
        if (!answer) return res.writeHead(202).end();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, key, close: () => server.close() };
}
