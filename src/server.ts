import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeMode } from "./codemode.js";
import { SELF_NAME } from "./upstream.js";
import { VERSION } from "./version.js";

const searchInput = {
  query: z.string().describe("Words that describe the tool you need. Empty lists a sample of tools."),
  server: z.string().optional().describe('Limit the search to one server ident, for example "notes".'),
  limit: z.number().int().min(1).max(25).optional().describe("How many matches to return. Default 8."),
};

const describeInput = {
  target: z
    .string()
    .describe(
      'A server ident ("notes"), a tool ("notes.get"), or a protocol method ("notes.resources.read", "notes.prompts.get").',
    ),
};

const executeInput = {
  code: z
    .string()
    .describe(
      "JavaScript run in a sandbox. Write an async function body, or a function such as `async () => { ... }`. Each server is a global. Return only the value you need.",
    ),
  timeout_ms: z.number().int().positive().optional().describe("Wall-clock limit for this run."),
  reset: z.boolean().optional().describe("Start from an empty session: no state, no globals, no handles."),
};

export type CodeModeServerOptions = {
  /**
   * Settles when the catalog is complete. The server answers the handshake at
   * once, and each tool call waits for this before it reads the catalog.
   */
  ready?: Promise<unknown>;
  /**
   * The host refuses methods not marked read-only (see `readOnlyPolicy`).
   * execute is then announced as read-only too, so clients can approve it.
   */
  readOnly?: boolean;
};

/** search and describe only read the catalog. Clients use this to approve them without asking. */
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/** execute can call any upstream tool, including ones that write. */
const RUNS_UPSTREAM_TOOLS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** With a read-only policy, execute can only reach methods their servers mark read-only. */
const RUNS_READ_ONLY_TOOLS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createCodeModeServer(mode: CodeMode, options: CodeModeServerOptions = {}): McpServer {
  const ready = options.ready ?? Promise.resolve();
  const server = new McpServer({
    name: SELF_NAME,
    version: VERSION,
  });

  server.registerTool(
    "search",
    {
      title: "Search tools",
      description:
        "Find methods on the upstream MCP servers by keyword. Lists every configured server and a few matches; the top ones include their TypeScript signature. Every server also has resources.list, resources.read, resources.templates, prompts.list, and prompts.get. execute can do the same lookup itself with codemode.search.",
      inputSchema: searchInput,
      annotations: READ_ONLY,
    },
    async ({ query, server: serverName, limit }) => {
      await ready;
      try {
        return jsonResult(mode.search(query, { server: serverName, limit }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "describe",
    {
      title: "Describe a tool",
      description:
        'Return the TypeScript signature for one server or one method: "notes", "notes.get", or "notes.resources.read". The first dot separates the server from the method. Inside execute, codemode.describe does the same.',
      inputSchema: describeInput,
      annotations: READ_ONLY,
    },
    async ({ target }) => {
      await ready;
      try {
        const typescript = mode.describe(target);
        return {
          content: [{ type: "text" as const, text: typescript }],
          structuredContent: { target, typescript },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "execute",
    {
      title: "Execute code",
      description: [
        "Run one JavaScript program that finds the methods it needs, calls them, filters, and returns only the answer. No network, filesystem, or credentials.",
        "Each upstream server is a global: `await notes.get({ id: \"1\" })`. Look methods up inside the program with `await codemode.search(\"query\")` and `await codemode.describe(\"server.method\")`.",
        "The code is an async function body. A method resolves to the value in its signature; when that is Promise<unknown>, sample it before returning anything large. Independent calls run concurrently with Promise.all.",
        "let and const do not survive between runs. Put what the next run needs on `state`:",
        "run 1 `state.threads = await gmail.search_threads({ query: \"newer_than:7d\" }); return state.threads.length;`",
        "run 2 `return state.threads.filter((thread) => thread.unread).length;`",
        "Images and binary results arrive as { $handle, type, mimeType }. Pass that object to another tool and it receives the bytes.",
        "reset: true starts an empty session. console.log output is returned.",
        ...(options.readOnly ? ["This session is read-only: methods their server does not mark read-only are refused."] : []),
      ].join(" "),
      inputSchema: executeInput,
      annotations: options.readOnly ? RUNS_READ_ONLY_TOOLS : RUNS_UPSTREAM_TOOLS,
    },
    async ({ code, timeout_ms, reset }) => {
      await ready;
      return jsonResult(await mode.execute(code, { timeoutMs: timeout_ms, reset }));
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const structured = isRecord(value) ? value : { value };
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
