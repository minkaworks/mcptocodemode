import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { defaultLimits, type Limits } from "./types.js";

export type ServerTransport = "stdio" | "http" | "sse";

/** One upstream MCP server, already normalized from whatever file it came from. */
export type ServerSpec = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport: ServerTransport;
};

export type CodeModeConfig = {
  servers: ServerSpec[];
  limits: Limits;
};

export type ParsedConfig = {
  servers: ServerSpec[];
  limits?: Partial<Limits>;
  issues: string[];
};

const LIMIT_KEYS = ["timeoutMs", "memoryBytes", "maxCalls", "maxCodeChars", "maxResultChars"] as const;
const BANNED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Read a config file. Accepts this project's `{ servers: [...] }` JSON,
 * the standard `{ mcpServers: { name: { command | url } } }` JSON used by
 * Claude, Cursor, and VS Code, and Grok/Codex `[mcp_servers.name]` TOML.
 */
export function parseConfig(text: string, filename: string, env: NodeJS.ProcessEnv = process.env): ParsedConfig {
  const format = configFormat(text, filename);
  let value: unknown;
  try {
    value = format === "toml" ? parseToml(text) : parseJsonLoose(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { servers: [], issues: [`Could not parse ${filename}: ${message}`] };
  }
  return configFromValue(value, filename, env);
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<CodeModeConfig> {
  return loadConfigs([path], env);
}

/** Merge config files. A later file replaces an earlier server with the same name. */
export async function loadConfigs(paths: string[], env: NodeJS.ProcessEnv = process.env): Promise<CodeModeConfig> {
  let servers: ServerSpec[] = [];
  let limits: Partial<Limits> = {};
  const problems: string[] = [];
  for (const filePath of paths) {
    const text = await readFile(filePath, "utf8");
    const parsed = parseConfig(text, filePath, env);
    problems.push(...parsed.issues);
    servers = mergeServers(servers, parsed.servers);
    if (parsed.limits) limits = { ...limits, ...parsed.limits };
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (servers.length === 0) throw new Error(`No MCP servers in ${paths.join(", ")}`);
  return { servers, limits: { ...defaultLimits, ...limits } };
}

export function mergeServers(base: ServerSpec[], next: ServerSpec[]): ServerSpec[] {
  const map = new Map(base.map((server) => [server.name, server]));
  for (const server of next) map.set(server.name, server);
  return [...map.values()];
}

function configFormat(text: string, filename: string): "json" | "toml" {
  if (filename.endsWith(".toml")) return "toml";
  if (filename.endsWith(".json")) return "json";
  return text.trimStart().startsWith("{") ? "json" : "toml";
}

function configFromValue(value: unknown, filename: string, env: NodeJS.ProcessEnv): ParsedConfig {
  if (!isRecord(value)) return { servers: [], issues: [`${filename} must be an object`] };

  const issues: string[] = [];
  const disabled = new Set(stringList(value.disabled_mcp_servers));
  const rawServers: Array<{ name: string; raw: unknown }> = [];

  if (isRecord(value.mcpServers)) pushMap(rawServers, value.mcpServers);
  if (isRecord(value.mcp) && isRecord(value.mcp.servers)) pushMap(rawServers, value.mcp.servers);
  collectServersField(value.servers, filename, rawServers, issues);
  if (isRecord(value.mcp_servers)) pushMap(rawServers, value.mcp_servers);

  const specs: ServerSpec[] = [];
  for (const entry of rawServers) {
    if (BANNED_NAMES.has(entry.name)) {
      issues.push(`Server name "${entry.name}" in ${filename} is not allowed`);
      continue;
    }
    if (disabled.has(entry.name)) continue;
    const spec = normalizeServer(entry.name, entry.raw, filename, env, issues);
    if (!spec) continue;
    const index = specs.findIndex((server) => server.name === spec.name);
    if (index >= 0) specs[index] = spec;
    else specs.push(spec);
  }

  return { servers: specs, limits: readLimits(value.limits, filename, issues), issues };
}

function collectServersField(
  value: unknown,
  filename: string,
  out: Array<{ name: string; raw: unknown }>,
  issues: string[],
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
        issues.push(`${filename} has a server entry without a name`);
        continue;
      }
      out.push({ name: entry.name, raw: entry });
    }
    return;
  }
  if (isRecord(value)) pushMap(out, value);
}

function pushMap(out: Array<{ name: string; raw: unknown }>, map: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(map)) {
    if (!name) continue;
    out.push({ name, raw });
  }
}

function normalizeServer(
  name: string,
  raw: unknown,
  filename: string,
  env: NodeJS.ProcessEnv,
  issues: string[],
): ServerSpec | undefined {
  if (!isRecord(raw)) {
    issues.push(`Server "${name}" in ${filename} is not an object`);
    return undefined;
  }
  if (raw.enabled === false) return undefined;

  const command = optionalString(raw.command, env);
  const url = optionalString(raw.url ?? raw.httpUrl, env);
  const declared = transportOf(raw.type ?? raw.transport);
  if (declared.error) {
    issues.push(`Server "${name}" in ${filename}: ${declared.error}`);
    return undefined;
  }
  if (command && url) {
    issues.push(`Server "${name}" in ${filename} needs exactly one of "command" or "url"`);
    return undefined;
  }
  const transport = declared.transport ?? (command ? "stdio" : url ? "http" : undefined);
  if (!transport) {
    issues.push(`Server "${name}" in ${filename} needs a command or a url`);
    return undefined;
  }
  if (transport === "stdio" && !command) {
    issues.push(`Server "${name}" in ${filename} uses stdio and needs a command`);
    return undefined;
  }
  if (transport !== "stdio" && !url) {
    issues.push(`Server "${name}" in ${filename} uses ${transport} and needs a url`);
    return undefined;
  }

  const spec: ServerSpec = { name, transport };
  if (command) spec.command = command;
  const args = stringArray(raw.args, env);
  if (args) spec.args = args;
  const vars = stringRecord(raw.env, env);
  if (vars) spec.env = vars;
  const cwd = optionalString(raw.cwd, env);
  if (cwd) spec.cwd = cwd;
  if (url) spec.url = url;
  const headers = stringRecord(raw.headers, env);
  if (headers) spec.headers = headers;
  return spec;
}

function transportOf(value: unknown): { transport?: ServerTransport; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string") return { error: "transport must be a string" };
  const type = value.toLowerCase().replace(/_/g, "-");
  if (type === "sse") return { transport: "sse" };
  if (type === "http" || type === "streamable-http") return { transport: "http" };
  if (type === "stdio") return { transport: "stdio" };
  return { error: `unknown transport "${value}"` };
}

function readLimits(value: unknown, filename: string, issues: string[]): Partial<Limits> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${filename} limits must be an object`);
    return undefined;
  }
  const limits: Partial<Limits> = {};
  for (const key of LIMIT_KEYS) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      issues.push(`${filename} limits.${key} must be a positive integer`);
      continue;
    }
    limits[key] = item;
  }
  return limits;
}

/** Expand `${VAR}` and `${VAR:-default}` from the process environment. Missing names stay literal. */
export function expandText(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (full, name: string, fallback: string | undefined) => {
    const current = env[name];
    if (current !== undefined) return current;
    if (fallback !== undefined) return fallback;
    return full;
  });
}

function optionalString(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== "string") return undefined;
  const expanded = expandText(value, env).trim();
  return expanded.length > 0 ? expanded : undefined;
}

function stringArray(value: unknown, env: NodeJS.ProcessEnv): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [expandText(value, env)];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(expandText(item, env));
    else if (typeof item === "number" || typeof item === "boolean") out.push(String(item));
  }
  return out;
}

function stringRecord(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = expandText(item, env);
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (first) {
    try {
      return JSON.parse(stripJsonComments(text)) as unknown;
    } catch {
      throw first;
    }
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: '"' | null = null;
  while (i < text.length) {
    const char = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"') {
      quote = '"';
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      const closer = text[j];
      if (closer === "}" || closer === "]") {
        i += 1;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
