import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { callUpstreamTool } from "./upstream.js";
import { catalogFromServers } from "./catalog.js";
import { CodeMode } from "./codemode.js";
import { attachmentBase64, createMailServer, mailExpected, mailProgram, mailPageSchema, mailMessageSchema, mailIndexedSchema } from "./demo-mail.js";

/** Real MCP calls against synthetic data; no model, config, network, or disk access. */
export async function measureMail() {
  const server = createMailServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure-mail", version: "0" });
  let mode: CodeMode | undefined;
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const plain: Array<{ tool: string; argumentBytes: number; resultBytes: number }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `Plain MCP call ${name} failed`);
      plain.push({ tool: name, argumentBytes: bytes(args), resultBytes: bytes(result.content) });
      return result;
    };
    let pageToken: string | undefined;
    const threads: z.infer<typeof mailPageSchema>["threads"] = [];
    do {
      const page = mailPageSchema.parse((await call("search_threads", { query: "in:inbox", ...(pageToken ? { pageToken } : {}) })).structuredContent);
      threads.push(...page.threads);
      pageToken = page.nextPageToken;
    } while (pageToken);
    const unread = threads.filter((thread) => thread.unread);
    const target = unread.find((thread) => thread.hasAttachment);
    assert.ok(target, "The fixture has no unread attachment");
    const message = mailMessageSchema.parse((await call("get_message", { id: target.id })).structuredContent);
    assert.ok(message.attachments[0], "The message has no attachment");
    const image = z.array(z.object({ type: z.literal("image"), data: z.string() })).parse(
      (await call("get_attachment", { id: message.attachments[0].id })).content,
    );
    assert.ok(image[0], "The attachment has no image data");
    const indexed = mailIndexedSchema.parse((await call("index_attachment", { file: image[0].data })).structuredContent);
    const plainAnswer = { unread: unread.length, thread: target.id, indexed };

    const listed = await client.listTools();
    const catalog = catalogFromServers([{ name: "mail", tools: listed.tools }]);
    const codeMode: CodeMode = new CodeMode(catalog, (toolCall) =>
      callUpstreamTool(client, toolCall.tool, toolCall.input, 200_000, codeMode.blobs));
    mode = codeMode;
    const started = performance.now();
    const result = await mode.execute(mailProgram, { reset: true });
    const ms = Math.round(performance.now() - started);
    assert.equal(result.ok, true, `Mail execute failed: ${result.error}`);
    const envelope = JSON.stringify(result);
    let running = 0;
    let reread = 0;
    for (const item of plain) {
      running += item.resultBytes + item.argumentBytes;
      reread += running;
    }
    return {
      task: "Count unread threads across 3 pages, then read, download, and index the first unread attachment",
      plain: {
        turns: plain.length,
        resultBytes: plain.reduce((sum, item) => sum + item.resultBytes, 0),
        argumentBytes: plain.reduce((sum, item) => sum + item.argumentBytes, 0),
        rereadBytes: reread,
        calls: plain,
        answer: plainAnswer,
        correct: JSON.stringify(plainAnswer) === JSON.stringify(mailExpected),
      },
      codeMode: {
        turns: 1,
        codeBytes: Buffer.byteLength(mailProgram),
        envelopeBytes: Buffer.byteLength(envelope),
        upstreamCalls: result.calls.reduce((sum, item) => sum + ("count" in item ? item.count : 1), 0),
        containsBase64: envelope.includes(attachmentBase64.slice(0, 64)),
        containsBody: envelope.includes("Quarterly numbers attached"),
        ms,
      },
      answer: result.result,
      correct: JSON.stringify(result.result) === JSON.stringify(mailExpected),
    };
  } finally {
    mode?.close();
    await client.close();
    await server.close();
  }
}

export async function runDemo(json = false): Promise<string> {
  const result = await measureMail();
  assert.equal(result.plain.correct, true, "Plain MCP returned the wrong answer");
  assert.equal(result.correct, true, "Code Mode returned the wrong answer");
  assert.deepEqual(result.plain.answer, result.answer, "The two paths disagree");
  assert.equal(result.codeMode.upstreamCalls, result.plain.calls.length, "The paths must perform the same upstream calls");
  assert.equal(result.codeMode.containsBase64, false, "Attachment bytes escaped into the answer");
  assert.equal(result.codeMode.containsBody, false, "The message body escaped into the answer");
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const rows: Array<[string, number, number]> = [
    ["Result bytes returned", result.plain.resultBytes, result.codeMode.envelopeBytes],
    ["Upstream tool calls", result.plain.calls.length, result.codeMode.upstreamCalls],
  ];
  return [
    "MCPtoCodeMode: try it without an API key", "",
    "Synthetic mailbox: 30 threads, 3 pages, one 150 KB attachment.",
    "Count unread threads and pass the first unread attachment to an indexer.", "",
    `${"".padEnd(28)}${"Plain MCP".padStart(14)}${"Code Mode".padStart(14)}`,
    ...rows.map(([label, plain, code]) => `${label.padEnd(28)}${String(plain).padStart(14)}${String(code).padStart(14)}`), "",
    `Both answers verified: ${JSON.stringify(result.answer)}`,
    "The attachment stays in the host; the sandbox passes a handle between tools.", "",
    "UTF-8 JSON bytes, not tokens, cost, or model accuracy. Code Mode includes",
    "its full execute envelope; plain MCP counts the returned content blocks.",
    "Discovery and input bytes are excluded from this table. No model ran.",
    "Use --json for the call breakdown, input bytes, and timing.", "",
  ].join("\n");
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}
