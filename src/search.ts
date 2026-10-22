import { findServer } from "./catalog.js";
import type { Catalog, SearchHit, ToolRecord, ServerNamespace } from "./types.js";

const STOP = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "and",
  "or",
  "in",
  "on",
  "with",
  "from",
  "by",
  "is",
  "it",
  "at",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1 && !STOP.has(token));
}

function oneLine(description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  if (line.length <= 220) return line;
  return `${line.slice(0, 219)}…`;
}

function scoreTool(query: string, queryTokens: string[], server: ServerNamespace, tool: ToolRecord): number {
  if (queryTokens.length === 0) return 1;
  const method = tool.method.toLowerCase();
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const serverName = `${server.name} ${server.ident}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (method === token || name === token) score += 12;
    else if (method.includes(token) || name.includes(token)) score += 6;
    if (description.includes(token)) score += 2;
    if (serverName.includes(token)) score += 3;
  }
  if (description.includes(query.toLowerCase().trim())) score += 4;
  return score;
}

export function searchCatalog(
  catalog: Catalog,
  query: string,
  options: { server?: string; limit?: number } = {},
): { servers: Array<{ name: string; ident: string; toolCount: number; error?: string }>; hits: SearchHit[] } {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
  const servers = catalog.servers.map((server) => ({
    name: server.name,
    ident: server.ident,
    toolCount: server.tools.filter((tool) => tool.kind !== "protocol").length,
    ...(server.error ? { error: server.error } : {}),
  }));

  let pool = catalog.servers;
  if (options.server) {
    const match = findServer(catalog, options.server);
    if (!match) {
      throw new Error(
        `Unknown server "${options.server}". Known servers: ${catalog.servers.map((server) => server.ident).join(", ")}`,
      );
    }
    pool = [match];
  }

  const queryTokens = tokens(query);
  const hits: SearchHit[] = [];
  for (const server of pool) {
    for (const tool of server.tools) {
      if (queryTokens.length === 0 && tool.kind === "protocol") continue;
      const score = scoreTool(query, queryTokens, server, tool);
      if (queryTokens.length > 0 && score === 0) continue;
      hits.push({
        server: server.ident,
        method: tool.method,
        tool: tool.name,
        description: oneLine(tool.description),
        required: tool.inputSchema.required ?? [],
        score,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.method.localeCompare(b.method));
  return { servers, hits: hits.slice(0, limit) };
}
