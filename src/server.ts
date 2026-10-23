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
};

export type CodeModeServerOptions = {
  /**
   * Settles when the catalog is complete. The server answers the handshake at
   * once, and each tool call waits for this before it reads the catalog.
   */
  ready?: Promise<unknown>;
};

/** search and describe only read the catalog. Clients use this to approve them without asking. */
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/** execute can call any upstream tool, including ones that write. */
const RUNS_UPSTREAM_TOOLS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

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
        "Find tools on the upstream MCP servers by keyword. The response lists every configured server and a few matches (server, method, required arguments, one line). The top matches include their TypeScript signature, so execute can often follow directly. Every server also has resources.list, resources.read, resources.templates, prompts.list, and prompts.get. Call describe before using an unfamiliar method, then execute.",
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
        'Return the TypeScript signature for one server or one method. Pass "notes" for the namespace, "notes.get" for a tool, or "notes.resources.read" for a protocol method. The first dot separates the server from the method. Read this before calling a method you have not used.',
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
        "Run JavaScript in a fresh sandbox. No network, filesystem, or credentials.",
        "Each upstream server is a global: `await notes.get({ id: \"1\" })`, `await notes.resources.read({ uri })`, `await notes.prompts.get({ name })`.",
        "codemode.search(query) and codemode.describe(target) work inside the sandbox.",
        "The code is an async function body, or a function expression. Return only the final value, computed in the code: filter, count, and slice there.",
        "A method resolves to the value in its signature, not to this tool's { ok, result } envelope. When the signature says Promise<unknown>, inspect a small sample (Object.keys, a slice) before returning anything large.",
        "Independent calls run concurrently with Promise.all.",
        "console.log is captured and returned with the result. Intermediate tool payloads stay in the sandbox.",
      ].join(" "),
      inputSchema: executeInput,
      annotations: RUNS_UPSTREAM_TOOLS,
    },
    async ({ code, timeout_ms }) => {
      await ready;
      return jsonResult(await mode.execute(code, { timeoutMs: timeout_ms }));
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
