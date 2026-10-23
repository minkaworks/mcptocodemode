import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import { createCodeModeServer } from "../src/server.js";

describe("MCP surface", () => {
  it("exposes only search, describe, and execute", async () => {
    const catalog = catalogFromServers([
      {
        name: "gmail",
        tools: [
          {
            name: "search",
            description: "Search email.",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
          },
          {
            name: "list_labels",
            description: "List labels.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    const mode = new CodeMode(catalog, async (call) => {
      if (call.method === "list_labels") return [{ id: "INBOX" }, { id: "Label_1" }];
      return [];
    });
    const mcp = createCodeModeServer(mode);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["describe", "execute", "search"]);
    const annotations = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.search?.readOnlyHint).toBe(true);
    expect(annotations.describe?.readOnlyHint).toBe(true);
    expect(annotations.execute).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const execute = listed.tools.find((tool) => tool.name === "execute");
    expect(execute?.description).toContain("state");
    expect(execute?.description).toContain("codemode.search");
    expect(Object.keys((execute?.inputSchema as { properties: object }).properties)).toContain("reset");
    // The three definitions stay small however many servers connect.
    const definitions = listed.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    expect(Buffer.byteLength(JSON.stringify(definitions))).toBeLessThan(4_000);

    // With a read-only policy, execute is announced as read-only so clients can approve it.
    const readOnly = createCodeModeServer(mode, { readOnly: true });
    const [roClient, roServer] = InMemoryTransport.createLinkedPair();
    const roMcp = new Client({ name: "test-ro", version: "0" });
    await Promise.all([roMcp.connect(roClient), readOnly.connect(roServer)]);
    const roExecute = (await roMcp.listTools()).tools.find((tool) => tool.name === "execute");
    expect(roExecute?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(roExecute?.description).toContain("read-only");
    await roMcp.close();
    await readOnly.close();

    const found = await client.callTool({ name: "search", arguments: { query: "labels" } });
    expect(JSON.stringify(found)).toContain("list_labels");

    const described = await client.callTool({ name: "describe", arguments: { target: "gmail.list_labels" } });
    expect(text(described)).toContain("gmail.list_labels");

    const executed = await client.callTool({
      name: "execute",
      arguments: {
        code: "const labels = await gmail.list_labels();\nreturn labels.map((label) => label.id);",
      },
    });
    const body = JSON.parse(text(executed)) as { ok: boolean; result: string[] };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual(["INBOX", "Label_1"]);

    await client.close();
    await mcp.close();
  });
});

function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

describe("registry through MCP", () => {
  it("lists available servers in search and confirms an install through elicitation", async () => {
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const { confirmInstall } = await import("../src/server.js");
    const catalog = catalogFromServers([]);
    const mode = new CodeMode(catalog, async () => null, {
      discover: async (query) => [{ name: `io.github.acme/${query}`, ready: true }],
    });
    const mcp = createCodeModeServer(mode, { registry: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "asks", version: "0" }, { capabilities: { elicitation: {} } });
    const prompts: string[] = [];
    let answer = true;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(String(request.params.message));
      return { action: "accept", content: { install: answer } };
    });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

    const found = JSON.parse(text(await client.callTool({ name: "search", arguments: { query: "notes" } }))) as { available: unknown[] };
    expect(found.available).toEqual([{ name: "io.github.acme/notes", ready: true }]);
    const execute = (await client.listTools()).tools.find((tool) => tool.name === "execute");
    expect(execute?.description).toContain("codemode.install");

    const request = { server: { name: "io.github.acme/notes" }, message: "Install io.github.acme/notes?" } as never;
    expect(await confirmInstall(mcp, request)).toBe(true);
    answer = false;
    expect(await confirmInstall(mcp, request)).toBe(false);
    expect(prompts).toEqual(["Install io.github.acme/notes?", "Install io.github.acme/notes?"]);
    await client.close();
    await mcp.close();

    // A client that cannot ask gets the terminal command instead.
    const silent = createCodeModeServer(mode, { registry: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const plain = new Client({ name: "silent", version: "0" });
    await Promise.all([plain.connect(a), silent.connect(b)]);
    await expect(confirmInstall(silent, request)).rejects.toThrow("npx mcptocodemode add io.github.acme/notes");
    await plain.close();
    await silent.close();
  });
});

