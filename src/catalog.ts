import { uniqueIdent } from "./ident.js";
import type { Catalog, JsonSchema, ListedTool, ServerNamespace, ToolRecord } from "./types.js";

const EMPTY_INPUT: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

const PROTOCOL_METHODS: Array<{ method: string; description: string; inputSchema: JsonSchema }> = [
  {
    method: "resources.list",
    description: "List resources this MCP server exposes.",
    inputSchema: EMPTY_INPUT,
  },
  {
    method: "resources.read",
    description: "Read one resource by uri.",
    inputSchema: {
      type: "object",
      required: ["uri"],
      additionalProperties: false,
      properties: { uri: { type: "string", description: "Resource URI." } },
    },
  },
  {
    method: "resources.templates",
    description: "List resource URI templates on this MCP server.",
    inputSchema: EMPTY_INPUT,
  },
  {
    method: "prompts.list",
    description: "List prompts this MCP server exposes.",
    inputSchema: EMPTY_INPUT,
  },
  {
    method: "prompts.get",
    description: "Get one prompt by name. Pass arguments when the prompt requires them.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Prompt name." },
        arguments: {
          type: "object",
          description: "Prompt arguments. Values are strings.",
          additionalProperties: { type: "string" },
        },
      },
    },
  },
];

function asSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") return EMPTY_INPUT;
  return schema;
}

function protocolRecords(serverName: string, ident: string): ToolRecord[] {
  return PROTOCOL_METHODS.map((method) => ({
    server: serverName,
    serverIdent: ident,
    name: method.method,
    method: method.method,
    description: method.description,
    inputSchema: method.inputSchema,
    kind: "protocol",
  }));
}

export function namespaceFromTools(serverName: string, tools: ListedTool[], usedServerIdents: Set<string>): ServerNamespace {
  return namespaceWithIdent(serverName, uniqueIdent(serverName, usedServerIdents), tools);
}

/** Build a namespace under an ident the caller already reserved. */
export function namespaceWithIdent(serverName: string, ident: string, tools: ListedTool[]): ServerNamespace {
  // `resources` and `prompts` are nested protocol objects on every server.
  const usedMethods = new Set<string>(["resources", "prompts"]);
  const records: ToolRecord[] = tools.map((tool) => ({
    server: serverName,
    serverIdent: ident,
    name: tool.name,
    method: uniqueIdent(tool.name, usedMethods),
    description: (tool.description ?? "").trim(),
    inputSchema: asSchema(tool.inputSchema),
    kind: "tool",
  }));
  return { name: serverName, ident, tools: [...protocolRecords(serverName, ident), ...records] };
}

export function failedNamespace(serverName: string, message: string, usedServerIdents: Set<string>): ServerNamespace {
  return {
    name: serverName,
    ident: uniqueIdent(serverName, usedServerIdents),
    tools: [],
    error: message,
  };
}

export function catalogFromServers(groups: Array<{ name: string; tools: ListedTool[] }>): Catalog {
  const used = new Set<string>();
  return {
    servers: groups.map((group) => namespaceFromTools(group.name, group.tools, used)),
  };
}

/**
 * Grok and some gateways flatten tools as `server__tool`.
 * Split on the first `__` and rebuild namespaces.
 */
export function catalogFromFlatTools(tools: ListedTool[]): Catalog {
  const groups = new Map<string, ListedTool[]>();
  for (const tool of tools) {
    const splitAt = tool.name.indexOf("__");
    if (splitAt <= 0) {
      throw new Error(`Expected a server__tool name, received "${tool.name}"`);
    }
    const server = tool.name.slice(0, splitAt);
    const name = tool.name.slice(splitAt + 2);
    const list = groups.get(server) ?? [];
    list.push({ ...tool, name });
    groups.set(server, list);
  }
  return catalogFromServers([...groups.entries()].map(([name, listed]) => ({ name, tools: listed })));
}

export function findServer(catalog: Catalog, nameOrIdent: string): ServerNamespace | undefined {
  return catalog.servers.find((server) => server.name === nameOrIdent || server.ident === nameOrIdent);
}

export function findTool(server: ServerNamespace, methodOrName: string): ToolRecord | undefined {
  return server.tools.find((tool) => tool.method === methodOrName || tool.name === methodOrName);
}
