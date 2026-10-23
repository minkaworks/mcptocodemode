// An MCP server behind OAuth, for tests: the SDK's auth router with its demo
// provider, which approves every authorization without asking.
import express from "express";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startOAuthServer() {
  const app = express();
  app.use(express.json());
  const provider = new DemoInMemoryAuthProvider();
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = new URL(`http://localhost:${server.address().port}`);
  const mcpUrl = new URL("/mcp", base);
  app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: ["mcp:tools"] }));
  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", auth, async (req, res) => {
    const mcp = new McpServer({ name: "secure", version: "0" });
    mcp.registerTool("whoami", { description: "Say which OAuth client is calling.", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ client: req.auth?.clientId ?? null }) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", auth, (_req, res) => res.status(405).end());
  return {
    url: mcpUrl.href,
    clients: () => provider.clientsStore.clients.size,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
