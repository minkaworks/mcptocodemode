import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "tiny", version: "0" });

server.registerTool(
  "ping",
  { description: "Reply pong.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
);

server.registerResource(
  "hello",
  "https://example.com/memo/hello",
  { description: "A short memo.", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello" }],
  }),
);

server.registerPrompt(
  "greet",
  { description: "Greet someone.", argsSchema: { name: z.string() } },
  async ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Hello ${name}` } }],
  }),
);

await server.connect(new StdioServerTransport());
