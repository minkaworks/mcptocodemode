// An in-process mail server for measurements. It is not Gmail: the data is
// deterministic, so a run can check its own answer. Thread n (1 to 30) is
// unread when n is divisible by 3 and has an attachment when n is divisible
// by 7. Pages hold 10 threads. Attachments are deterministic synthetic bytes
// with a PNG header; this exercises byte transport, not image decoding.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const THREADS = 30;
const PAGE = 10;
const SNIPPET_CHARS = 600;
const BODY_CHARS = 8_000;
const IMAGE_BYTES = 150_000;

const filler =
  "Quarterly numbers attached. The vendor confirmed the shipment window and asked us to sign off on the revised invoice before Friday. ";

function threadId(n: number) {
  return `t${String(n).padStart(2, "0")}`;
}

function thread(n: number) {
  return {
    id: threadId(n),
    subject: `Order update ${n}`,
    from: `vendor${n % 4}@example.com`,
    unread: n % 3 === 0,
    hasAttachment: n % 7 === 0,
    snippet: filler.repeat(Math.ceil(SNIPPET_CHARS / filler.length)).slice(0, SNIPPET_CHARS),
  };
}

/** A PNG signature followed by deterministic bytes. */
export const attachmentBase64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: IMAGE_BYTES - 8 }, (_, i) => (i * 31) % 251)),
]).toString("base64");

/** What a correct run of the mail task returns. */
export const mailExpected = (() => {
  const unread = Array.from({ length: THREADS }, (_, i) => thread(i + 1)).filter((item) => item.unread);
  const target = unread.find((item) => item.hasAttachment);
  return { unread: unread.length, thread: target!.id, indexed: { bytes: IMAGE_BYTES, mimeType: "image/png" } };
})();

const threadShape = z.object({
  id: z.string(),
  subject: z.string(),
  from: z.string(),
  unread: z.boolean(),
  hasAttachment: z.boolean(),
  snippet: z.string(),
});

export const mailPageSchema = z.object({ threads: z.array(threadShape), nextPageToken: z.string().optional() });
export const mailMessageSchema = z.object({
  id: z.string(), subject: z.string(), body: z.string(),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), mimeType: z.string() })),
});
export const mailIndexedSchema = z.object({ bytes: z.number(), mimeType: z.string() });

export function createMailServer() {
  const server = new McpServer({ name: "mail", version: "0" });
  server.registerTool(
    "search_threads",
    {
      description: "Search mail threads. Returns one page of threads and nextPageToken when there are more.",
      inputSchema: { query: z.string(), pageToken: z.string().optional() },
      outputSchema: mailPageSchema.shape,
    },
    async ({ pageToken }) => {
      const page = pageToken ? Number(pageToken.replace("page-", "")) : 1;
      const start = (page - 1) * PAGE;
      const threads = Array.from({ length: PAGE }, (_, i) => thread(start + i + 1)).filter((item) => Number(item.id.slice(1)) <= THREADS);
      const next = start + PAGE < THREADS ? `page-${page + 1}` : undefined;
      const value = { threads, ...(next ? { nextPageToken: next } : {}) };
      return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  );

  server.registerTool(
    "get_message",
    {
      description: "Read the newest message of a thread: headers, the full body, and its attachments.",
      inputSchema: { id: z.string() },
      outputSchema: mailMessageSchema.shape,
    },
    async ({ id }) => {
      const n = Number(id.slice(1));
      const value = {
        id,
        subject: `Order update ${n}`,
        body: filler.repeat(Math.ceil(BODY_CHARS / filler.length)).slice(0, BODY_CHARS),
        attachments: n % 7 === 0 ? [{ id: `att-${id}`, filename: "invoice.png", mimeType: "image/png" }] : [],
      };
      return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  );

  server.registerTool(
    "get_attachment",
    {
      description: "Download one attachment. Returns it as an image content block.",
      inputSchema: { id: z.string() },
    },
    async () => ({ content: [{ type: "image", data: attachmentBase64, mimeType: "image/png" }] }),
  );

  server.registerTool(
    "index_attachment",
    {
      description: "Index a file for search. Pass the file as base64. Returns its size and detected type.",
      inputSchema: { file: z.string().describe("Base64 file contents.") },
      outputSchema: mailIndexedSchema.shape,
    },
    async ({ file }) => {
      const bytes = Buffer.from(file, "base64");
      const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const value = { bytes: bytes.length, mimeType: png ? "image/png" : "application/octet-stream" };
      return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  );

  return server;
}

/** The program a model would write for the mail task in one execute. */
export const mailProgram = `let pageToken;
const threads = [];
do {
  const page = await mail.search_threads({ query: "in:inbox", pageToken });
  threads.push(...page.threads);
  pageToken = page.nextPageToken;
} while (pageToken);
const unread = threads.filter((thread) => thread.unread);
const target = unread.find((thread) => thread.hasAttachment);
const message = await mail.get_message({ id: target.id });
const image = await mail.get_attachment({ id: message.attachments[0].id });
const indexed = await mail.index_attachment({ file: image });
return { unread: unread.length, thread: target.id, indexed };`;

export const mailPrompt = `In the mailbox, search_threads with the query "in:inbox" returns pages of threads. Count the unread threads across every page. Then take the first unread thread, in page order, that has an attachment, read its message, download its first attachment, and index that attachment with index_attachment. Reply as {"unread": number, "thread": string, "indexed": {"bytes": number, "mimeType": string}}.`;
