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
