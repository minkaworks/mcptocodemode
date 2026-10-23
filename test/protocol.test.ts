import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogFromServers, namespaceFromTools } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import { describeTarget } from "../src/describe.js";
import { searchCatalog } from "../src/search.js";
import { UpstreamPool } from "../src/upstream.js";

describe("protocol methods", () => {
  it("reserves resources and prompts and describes a dotted method", () => {
    const server = namespaceFromTools(
      "box",
      [{ name: "resources", description: "Not the protocol object.", inputSchema: { type: "object", properties: {} } }],
      new Set(),
    );
    expect(server.tools.find((tool) => tool.name === "resources")?.method).toBe("resources_2");
    const typescript = describeTarget({ servers: [server] }, "box.resources.read");
    expect(typescript).toContain("box.resources.read(input:");
    expect(typescript).toContain("uri: string");
  });

  it("keeps protocol methods out of an empty search and finds them by name", () => {
    const catalog = catalogFromServers([
      {
        name: "notes",
        tools: [{ name: "list", description: "List notes.", inputSchema: { type: "object", properties: {} } }],
      },
    ]);
    const sample = searchCatalog(catalog, "");
    expect(sample.servers[0]).toEqual({ name: "notes", ident: "notes", toolCount: 1 });
    expect(sample.hits.map((hit) => hit.method)).toEqual(["list"]);
    const found = searchCatalog(catalog, "resources");
    expect(found.hits.some((hit) => hit.method === "resources.list")).toBe(true);
  });

  it("calls resources and prompts from the sandbox", async () => {
    const catalog = catalogFromServers([
      { name: "notes", tools: [{ name: "list", description: "List notes.", inputSchema: { type: "object", properties: {} } }] },
    ]);
    const mode = new CodeMode(catalog, async (call) => {
      if (call.method === "resources.read") return { uri: call.input.uri, text: "hello" };
      if (call.method === "prompts.get") return { messages: [{ role: "user", content: { type: "text", text: "Hi" } }] };
      throw new Error(call.method);
    });
    const result = await mode.execute(`
      const memo = await notes.resources.read({ uri: "note://1" });
      const prompt = await notes.prompts.get({ name: "summarize" });
      return { memo, prompt };
    `);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      memo: { uri: "note://1", text: "hello" },
      prompt: { messages: [{ role: "user", content: { type: "text", text: "Hi" } }] },
    });
    expect(result.calls.map((call) => call.method)).toEqual(["resources.read", "prompts.get"]);
  });
});

describe("upstream isolation", () => {
  it("keeps a working server when another MCP process fails", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/tiny-mcp.mjs", import.meta.url));
    const pool = await UpstreamPool.connect([
      { name: "broken", command: process.execPath, args: ["-e", "process.exit(2)"], transport: "stdio" },
      { name: "tiny", command: process.execPath, args: [fixture], transport: "stdio" },
    ]);
    try {
      expect(pool.failures.map((failure) => failure.name)).toEqual(["broken"]);
      expect(pool.catalog.servers.find((server) => server.name === "broken")?.error).toBeTruthy();
      const ping = pool.catalog.servers.find((server) => server.name === "tiny")?.tools.find((tool) => tool.method === "ping");
      expect(ping?.annotations).toEqual({ readOnlyHint: true });
      const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000));
      const result = await mode.execute(`
        const pong = await tiny.ping();
        const memo = await tiny.resources.read({ uri: "https://example.com/memo/hello" });
        const prompt = await tiny.prompts.get({ name: "greet", arguments: { name: "ada" } });
        return { pong, memo, prompt };
      `);
      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        pong: { ok: true },
        memo: { text: "hello" },
        prompt: { messages: [{ role: "user", content: { type: "text", text: "Hello ada" } }] },
      });
    } finally {
      await pool.close();
    }
  }, 20_000);
});
