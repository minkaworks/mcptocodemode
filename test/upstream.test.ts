import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import { callUpstreamTool, valueFromToolResult } from "../src/upstream.js";

describe("upstream tool results", () => {
  it("calls a real MCP server and truncates oversized payloads", async () => {
    const upstream = new McpServer({ name: "notes", version: "0" });
    upstream.registerTool(
      "echo",
      {
        description: "Echo a message.",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        structuredContent: { message },
        content: [{ type: "text" as const, text: JSON.stringify({ message }) }],
      }),
    );
    upstream.registerTool(
      "fail",
      { description: "Always fails.", inputSchema: {} },
      async () => ({ isError: true, content: [{ type: "text" as const, text: "nope" }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcptocodemode", version: "0" });
    await Promise.all([client.connect(clientTransport), upstream.connect(serverTransport)]);

    const listed = await client.listTools();
    const catalog = catalogFromServers([{ name: "notes", tools: listed.tools }]);
    const mode = new CodeMode(catalog, (call) => callUpstreamTool(client, call.tool, call.input, 50));

    const echoed = await mode.execute(`return await notes.echo({ message: "hi" });`);
    expect(echoed.ok).toBe(true);
    expect(echoed.result).toEqual({ message: "hi" });

    const failed = await mode.execute(`return await notes.fail();`);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("nope");

    const capped = valueFromToolResult(
      { structuredContent: { blob: "x".repeat(80) } },
      20,
    );
    expect(capped).toMatchObject({ truncated: true });

    await client.close();
    await upstream.close();
  });
});
