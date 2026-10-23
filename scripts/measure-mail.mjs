// Bytes returned to the caller for one mail task, plain MCP against one
// execute. The mail server runs in this process. No model is in the loop.
//
//   pnpm build && node scripts/measure-mail.mjs
//
// `pnpm measure` runs this too and stores the result under `mail`.
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callUpstreamTool, catalogFromServers, CodeMode } from "../dist/index.js";
import { attachmentBase64, createMailServer, mailExpected, mailProgram } from "./fixtures/mail-server.mjs";

export async function measureMail() {
  const server = createMailServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure-mail", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    // Plain MCP: each call is a turn, and its content blocks go to the model as they are.
    const plain = [];
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      plain.push({
        tool: name,
        argumentBytes: bytes(JSON.stringify(args)),
        resultBytes: bytes(JSON.stringify(result.content)),
      });
      return result.structuredContent ?? result.content;
    };
    let pageToken;
    const threads = [];
    do {
      const page = await call("search_threads", { query: "in:inbox", ...(pageToken ? { pageToken } : {}) });
      threads.push(...page.threads);
      pageToken = page.nextPageToken;
    } while (pageToken);
    const target = threads.filter((thread) => thread.unread).find((thread) => thread.hasAttachment);
    const message = await call("get_message", { id: target.id });
    const image = await call("get_attachment", { id: message.attachments[0].id });
    // The model has to write the bytes back out as the next call's argument.
    await call("index_attachment", { file: image[0].data });

    // Code Mode: one execute. The image stays in the host as a handle.
    const listed = await client.listTools();
    const catalog = catalogFromServers([{ name: "mail", tools: listed.tools }]);
    const mode = new CodeMode(catalog, (toolCall) => callUpstreamTool(client, toolCall.tool, toolCall.input, 200_000, mode.blobs));
    const started = performance.now();
    const result = await mode.execute(mailProgram, { reset: true });
    const ms = Math.round(performance.now() - started);
    mode.close();
    if (!result.ok) throw new Error(`mail execute failed: ${result.error}`);
    const envelope = JSON.stringify(result);

    const resultBytes = plain.reduce((sum, item) => sum + item.resultBytes, 0);
    const argumentBytes = plain.reduce((sum, item) => sum + item.argumentBytes, 0);
    let running = 0;
    let reread = 0;
    for (const item of plain) {
      running += item.resultBytes + item.argumentBytes;
      reread += running;
    }
    return {
      task: "Count unread threads across 3 pages, then read, download, and index the first unread attachment",
      plain: { turns: plain.length, resultBytes, argumentBytes, rereadBytes: reread, calls: plain },
      codeMode: {
        turns: 1,
        codeBytes: bytes(mailProgram),
        envelopeBytes: bytes(envelope),
        upstreamCalls: result.calls.reduce((sum, item) => sum + ("count" in item ? item.count : 1), 0),
        containsBase64: envelope.includes(attachmentBase64.slice(0, 64)),
        containsBody: envelope.includes("Quarterly numbers attached"),
        ms,
      },
      answer: result.result,
      correct: JSON.stringify(result.result) === JSON.stringify(mailExpected),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function bytes(text) {
  return Buffer.byteLength(text);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await measureMail(), null, 2)}\n`);
}
