import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import { DEPTH_ENV, UpstreamPool, callUpstreamTool, childEnv, nestingDepth, valueFromToolResult } from "../src/upstream.js";

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

  it("gives up on a server that never answers and keeps the order of the others", async () => {
    const started = Date.now();
    const pool = await UpstreamPool.connect(
      [
        { name: "silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], transport: "stdio" },
        { name: "gone", command: process.execPath, args: ["-e", "process.exit(2)"], transport: "stdio" },
      ],
      { timeoutMs: 400 },
    );
    try {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(pool.failures.map((failure) => failure.name)).toEqual(["silent", "gone"]);
      expect(pool.failures[0]?.message).toContain("no answer within 400 ms");
    } finally {
      await pool.close();
    }
  }, 10_000);
});

describe("nesting", () => {
  it("passes the next depth to stdio children", () => {
    expect(nestingDepth({})).toBe(0);
    expect(nestingDepth({ [DEPTH_ENV]: "2" })).toBe(2);
    expect(nestingDepth({ [DEPTH_ENV]: "nope" })).toBe(0);
    const env = childEnv({ name: "x", transport: "stdio", command: "x", env: { TOKEN: "t" } }, 1);
    expect(env).toMatchObject({ TOKEN: "t", [DEPTH_ENV]: "1" });
    expect(env.PATH).toBeTruthy();
  });
});
