import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CatalogCache } from "./cache.js";
import { findServer, namespaceWithIdent } from "./catalog.js";
import { uniqueIdent } from "./ident.js";
import type { ServerSpec } from "./config.js";
import type { Catalog, JsonSchema, ListedTool, ToolCall } from "./types.js";
import { VERSION } from "./version.js";

type ContentBlock = {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { text?: string; uri?: string; mimeType?: string; blob?: string };
  uri?: string;
  name?: string;
};

type ToolResult = {
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  toolResult?: unknown;
};

type Session = {
  spec: ServerSpec;
  client: Client;
  tools: ListedTool[];
};

/** One configured server. `session` is set once a connect starts and is reused after that. */
type Entry = {
  spec: ServerSpec;
  ident: string;
  index: number;
  session?: Promise<Session>;
  client?: Client;
};

export type ConnectFailure = {
  name: string;
  message: string;
};

export type PoolOptions = {
  /** How long one server may take to answer the handshake and the tool list. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Tool lists from earlier runs. `start` reads it; every successful connect writes it. */
  cache?: CatalogCache;
  /**
   * When true, a server with a cached tool list is not launched until code
   * calls it. When false, every server connects now and the cache is not read.
   */
  lazy?: boolean;
  /**
   * With `lazy`, also connect cached servers in the background without
   * holding up `ready`. The model's first turn usually hides the launch.
   * False leaves a cached server unlaunched until code calls it.
   */
  prewarm?: boolean;
  /** Called for each connect failure, including one that happens on a first call. */
  onFailure?: (failure: ConnectFailure) => void;
};

/**
 * Set on every stdio child. A client config that lists this server would
 * otherwise make each child discover and launch the next one without end.
 */
export const DEPTH_ENV = "MCPTOCODEMODE_DEPTH";

export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

const PROTOCOL = new Set(["resources.list", "resources.read", "resources.templates", "prompts.list", "prompts.get"]);

export class UpstreamPool {
  /** Shared with the sandbox. A namespace is replaced in place when its server connects. */
  readonly catalog: Catalog;
  /** Settles when every server that had to connect at start has connected or failed. It never rejects. */
  readonly ready: Promise<void>;
  private readonly entries: Entry[];
  private readonly timeoutMs: number;
  private readonly depth: number;
  private readonly cache?: CatalogCache;
  private readonly onFailure?: (failure: ConnectFailure) => void;
  private closed = false;

  private constructor(specs: ServerSpec[], options: PoolOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.depth = nestingDepth(options.env ?? process.env) + 1;
    this.cache = options.cache;
    this.onFailure = options.onFailure;
    const used = new Set<string>();
    this.entries = specs.map((spec, index) => ({ spec, ident: uniqueIdent(spec.name, used), index }));
    this.catalog = { servers: this.entries.map((entry) => ({ name: entry.spec.name, ident: entry.ident, tools: [] })) };

    const now: Array<Promise<unknown>> = [];
    for (const entry of this.entries) {
      const cached = options.lazy ? this.cache?.read(entry.spec) : undefined;
      if (!cached) {
        now.push(this.open(entry).catch(() => undefined));
        continue;
      }
      this.catalog.servers[entry.index] = namespaceWithIdent(entry.spec.name, entry.ident, cached);
      if (options.prewarm) void this.open(entry).catch(() => undefined);
    }
    this.ready = Promise.all(now).then(() => undefined);
  }

  /**
   * Answer at once. Servers with a cached tool list are usable right away and
   * connect in the background (or on first call without `prewarm`). The rest
   * connect now, and `ready` settles when they are done.
   */
  static start(specs: ServerSpec[], options: PoolOptions = {}): UpstreamPool {
    return new UpstreamPool(specs, { lazy: true, prewarm: true, ...options });
  }

  /**
   * Connect every server at once. One failure, or one server that does not
   * answer within `timeoutMs`, is recorded and the rest continue.
   */
  static async connect(specs: ServerSpec[], options: PoolOptions = {}): Promise<UpstreamPool> {
    const pool = new UpstreamPool(specs, { ...options, lazy: false });
    await pool.ready;
    return pool;
  }

  /** Servers that failed to connect so far, in config order. */
  get failures(): ConnectFailure[] {
    return this.catalog.servers.flatMap((server) => (server.error ? [{ name: server.name, message: server.error }] : []));
  }

  /** Names of the servers with a live connection. */
  get connected(): string[] {
    return this.entries.filter((entry) => entry.client).map((entry) => entry.spec.name);
  }

  async call(call: ToolCall, maxResultChars: number): Promise<unknown> {
    const namespace = findServer(this.catalog, call.server);
    const entry = this.entries.find((item) => item.ident === namespace?.ident);
    if (!namespace || !entry) throw new Error(`No upstream server named "${call.server}"`);
    if (namespace.error) throw new Error(`${namespace.ident} did not connect: ${namespace.error}`);
    let session: Session;
    try {
      session = await this.open(entry);
    } catch (error) {
      throw new Error(`${namespace.ident} did not connect: ${publicError(error)}`);
    }
    if (PROTOCOL.has(call.method)) return callProtocol(session.client, call, maxResultChars);
    const tool = session.tools.find((item) => item.name === call.tool);
    if (!tool) throw new Error(`${namespace.ident} has no tool "${call.tool}"`);
    return callUpstreamTool(session.client, tool.name, call.input, maxResultChars);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.entries.map((entry) => entry.client?.close().catch(() => undefined)));
  }

  /** Connect once. Later calls share the same attempt, successful or not. */
  private open(entry: Entry): Promise<Session> {
    entry.session ??= connectOne(entry.spec, this.timeoutMs, this.depth).then(
      async (session) => {
        if (this.closed) {
          await session.client.close().catch(() => undefined);
          throw new Error("pool closed");
        }
        entry.client = session.client;
        this.catalog.servers[entry.index] = namespaceWithIdent(entry.spec.name, entry.ident, session.tools);
        this.cache?.write(entry.spec, session.tools);
        return session;
      },
      (error: unknown) => {
        const failure = { name: entry.spec.name, message: publicError(error) };
        this.catalog.servers[entry.index] = { name: entry.spec.name, ident: entry.ident, tools: [], error: failure.message };
        this.onFailure?.(failure);
        throw error;
      },
    );
    return entry.session;
  }
}

export function publicError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split("\n")[0] ?? "connect failed";
  return line
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|api[-_]?key|token)\b\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 300);
}

/** How many mcptocodemode processes sit above this one. 0 for the one a client started. */
export function nestingDepth(env: NodeJS.ProcessEnv): number {
  const depth = Number.parseInt(env[DEPTH_ENV] ?? "", 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/** Environment for a stdio child: the SDK defaults, the server's own env, and the nesting depth. */
export function childEnv(spec: ServerSpec, depth: number): Record<string, string> {
  return { ...getDefaultEnvironment(), ...spec.env, [DEPTH_ENV]: String(depth) };
}

async function connectOne(spec: ServerSpec, timeoutMs: number, depth: number): Promise<Session> {
  const client = new Client({ name: "mcptocodemode", version: VERSION });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(openTransport(spec, depth));
        return listAllTools(client);
      })(),
      deadline,
    ]);
    return { spec, client, tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openTransport(spec: ServerSpec, depth: number): Transport {
  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`Server "${spec.name}" needs a command`);
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: childEnv(spec, depth),
      cwd: spec.cwd,
    });
  }
  if (!spec.url) throw new Error(`Server "${spec.name}" needs a url`);
  const url = new URL(spec.url);
  const requestInit = spec.headers ? { headers: spec.headers } : undefined;
  if (spec.transport === "sse") return new SSEClientTransport(url, { requestInit });
  return new StreamableHTTPClientTransport(url, { requestInit });
}

async function listAllTools(client: Client): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    if (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as JsonSchema,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function callProtocol(client: Client, call: ToolCall, maxResultChars: number): Promise<unknown> {
  if (call.method === "resources.list") {
    const resources = await everyPage(async (cursor) => {
      const page = await client.listResources(cursor ? { cursor } : undefined);
      return {
        items: page.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          ...(resource.description ? { description: resource.description } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          ...(resource.size !== undefined ? { size: resource.size } : {}),
        })),
        nextCursor: page.nextCursor,
      };
    });
    return cap(resources, maxResultChars);
  }
  if (call.method === "resources.templates") {
    const templates = await everyPage(async (cursor) => {
      const page = await client.listResourceTemplates(cursor ? { cursor } : undefined);
      return {
        items: page.resourceTemplates.map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
          ...(template.description ? { description: template.description } : {}),
          ...(template.mimeType ? { mimeType: template.mimeType } : {}),
        })),
        nextCursor: page.nextCursor,
      };
    });
    return cap(templates, maxResultChars);
  }
  if (call.method === "resources.read") {
    const uri = call.input.uri;
    if (typeof uri !== "string" || uri.length === 0) throw new Error("resources.read expects { uri: string }");
    const result = await client.readResource({ uri });
    return cap(slimContents(result.contents), maxResultChars);
  }
  if (call.method === "prompts.list") {
    const prompts = await everyPage(async (cursor) => {
      const page = await client.listPrompts(cursor ? { cursor } : undefined);
      return {
        items: page.prompts.map((prompt) => ({
          name: prompt.name,
          ...(prompt.title ? { title: prompt.title } : {}),
          ...(prompt.description ? { description: prompt.description } : {}),
          ...(prompt.arguments
            ? {
                arguments: prompt.arguments.map((argument) => ({
                  name: argument.name,
                  ...(argument.description ? { description: argument.description } : {}),
                  ...(argument.required ? { required: true } : {}),
                })),
              }
            : {}),
        })),
        nextCursor: page.nextCursor,
      };
    });
    return cap(prompts, maxResultChars);
  }
  if (call.method === "prompts.get") {
    const name = call.input.name;
    if (typeof name !== "string" || name.length === 0) throw new Error("prompts.get expects { name: string }");
    const result = await client.getPrompt({ name, arguments: promptArguments(call.input) });
    return cap(
      {
        ...(result.description ? { description: result.description } : {}),
        messages: result.messages.map((message) => ({
          role: message.role,
          content: slimPromptContent(message.content as ContentBlock),
        })),
      },
      maxResultChars,
    );
  }
  throw new Error(`Unknown protocol method "${call.method}"`);
}

async function everyPage<T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function slimContents(
  contents: Array<{ uri: string; mimeType?: string; text?: string } | { uri: string; mimeType?: string; blob: string }>,
): unknown {
  const mapped = contents.map((item) => {
    if ("text" in item && typeof item.text === "string") {
      return {
        uri: item.uri,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        text: parseMaybeJson(item.text),
      };
    }
    return {
      uri: item.uri,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      type: "blob",
      omitted: true,
    };
  });
  return mapped.length === 1 ? mapped[0] : mapped;
}

function slimPromptContent(content: ContentBlock): unknown {
  if (content.type === "text" && typeof content.text === "string") return { type: "text", text: content.text };
  if (content.type === "image" || content.type === "audio") {
    return { type: content.type, mimeType: content.mimeType, omitted: true };
  }
  if (content.type === "resource" && content.resource) {
    if (typeof content.resource.text === "string") {
      return {
        type: "resource",
        uri: content.resource.uri,
        text: content.resource.text,
        ...(content.resource.mimeType ? { mimeType: content.resource.mimeType } : {}),
      };
    }
    return { type: "resource", uri: content.resource.uri, omitted: true };
  }
  if (content.type === "resource_link") return { type: "resource_link", uri: content.uri, name: content.name };
  return { type: content.type, omitted: true };
}

function promptArguments(input: Record<string, unknown>): Record<string, string> | undefined {
  if (input.arguments === undefined) return undefined;
  if (!isRecord(input.arguments)) throw new Error("prompts.get arguments must be an object");
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.arguments)) {
    if (typeof value === "string") args[key] = value;
    else if (value === undefined || value === null) continue;
    else args[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return args;
}

export async function callUpstreamTool(
  client: Client,
  toolName: string,
  input: Record<string, unknown>,
  maxResultChars: number,
): Promise<unknown> {
  const result = (await client.callTool({ name: toolName, arguments: input })) as ToolResult;
  return valueFromToolResult(result, maxResultChars);
}

export function valueFromToolResult(result: ToolResult, maxResultChars: number): unknown {
  if (result.isError) {
    throw new Error(textOf(result.content) || "Tool call failed");
  }
  if (result.structuredContent) return cap(result.structuredContent, maxResultChars);
  if (result.toolResult !== undefined && result.content === undefined) {
    return cap(result.toolResult, maxResultChars);
  }
  return cap(contentValue(result.content ?? []), maxResultChars);
}

function contentValue(blocks: ContentBlock[]): unknown {
  if (blocks.length === 0) return null;
  const first = blocks[0];
  if (blocks.length === 1 && first) return blockValue(first);
  return blocks.map((block) => blockValue(block));
}

function blockValue(block: ContentBlock): unknown {
  if (block.type === "text") return parseMaybeJson(block.text ?? "");
  if (block.type === "image" || block.type === "audio") {
    return { type: block.type, mimeType: block.mimeType ?? "application/octet-stream", omitted: true };
  }
  if (block.type === "resource" && block.resource?.text !== undefined) return block.resource.text;
  return { type: block.type };
}

function textOf(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((block) => block.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function cap(value: unknown, maxChars: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { unserializable: true };
  }
  if (json.length <= maxChars) return value;
  return {
    truncated: true,
    bytes: json.length,
    preview: json.slice(0, Math.min(4_000, maxChars)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
