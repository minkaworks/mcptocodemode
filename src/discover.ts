import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeServers, parseConfig, type CodeModeConfig, type ServerSpec } from "./config.js";
import { defaultLimits, type Limits } from "./types.js";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type DiscoverOptions = {
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type DiscoverResult = CodeModeConfig & {
  files: string[];
  warnings: string[];
};

/**
 * Read MCP configs the user already has. This does not contact a registry and
 * does not launch anything. Explicit `--config` skips discovery.
 *
 * Later files replace earlier servers with the same name. Project files outrank
 * the home directory, and the working directory outranks the git root.
 */
export async function discoverConfig(options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = await discoveryPaths(cwd, home, platform);
  const claudeJson = path.join(home, ".claude.json");
  const projectKeys = [...new Set([await findProjectRoot(cwd), path.resolve(cwd)])];

  const files: string[] = [];
  const warnings: string[] = [];
  let servers: ServerSpec[] = [];
  let limits: Partial<Limits> = {};

  for (const candidate of candidates) {
    let info;
    try {
      info = await stat(candidate);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_CONFIG_BYTES) {
      warnings.push(`Skipped ${candidate}: larger than 8 MiB`);
      continue;
    }
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      warnings.push(`Skipped ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseConfig(text, candidate, env);
    if (candidate === claudeJson) {
      // `claude mcp add` defaults to local scope, stored per project directory.
      const local = claudeProjectServers(text, projectKeys, candidate, env);
      parsed.servers = mergeServers(parsed.servers, local.servers);
      parsed.issues.push(...local.issues);
    }
    warnings.push(...parsed.issues);
    if (parsed.servers.length === 0 && !parsed.limits) continue;
    files.push(candidate);
    servers = mergeServers(servers, parsed.servers);
    if (parsed.limits) limits = { ...limits, ...parsed.limits };
  }

  return { servers, limits: { ...defaultLimits, ...limits }, files, warnings };
}

/** Servers Claude Code stores under `projects["<dir>"].mcpServers` in `~/.claude.json`. */
function claudeProjectServers(
  text: string,
  projectKeys: string[],
  filename: string,
  env: NodeJS.ProcessEnv,
): { servers: ServerSpec[]; issues: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { servers: [], issues: [] };
  }
  const projects = isRecord(value) && isRecord(value.projects) ? value.projects : {};
  let servers: ServerSpec[] = [];
  const issues: string[] = [];
  for (const key of projectKeys) {
    const project = projects[key];
    if (!isRecord(project) || !isRecord(project.mcpServers)) continue;
    const parsed = parseConfig(JSON.stringify({ mcpServers: project.mcpServers }), `${filename} (${key})`, env);
    servers = mergeServers(servers, parsed.servers);
    issues.push(...parsed.issues);
  }
  return { servers, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function discoveryPaths(cwd: string, home: string, platform: NodeJS.Platform): Promise<string[]> {
  const homeFiles = [
    path.join(home, ".codex", "config.toml"),
    claudeDesktopConfig(home, platform),
    path.join(home, ".claude.json"),
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".grok", "config.toml"),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "mcp", "mcp.json"),
    path.join(home, ".pi", "agent", "mcp.json"),
  ];
  const root = await findProjectRoot(cwd);
  const project: string[] = [];
  for (const dir of fromRootToCwd(root, cwd)) {
    project.push(
      path.join(dir, ".mcp.json"),
      path.join(dir, "mcp.json"),
      path.join(dir, ".cursor", "mcp.json"),
      path.join(dir, ".vscode", "mcp.json"),
      path.join(dir, ".grok", "config.toml"),
      path.join(dir, ".codex", "config.toml"),
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
      path.join(dir, ".pi", "mcp.json"),
    );
  }
  project.push(path.join(path.resolve(cwd), "mcptocodemode.config.json"));
  return [...homeFiles, ...project];
}

function claudeDesktopConfig(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

async function findProjectRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  const stop = path.parse(dir).root;
  while (dir !== stop) {
    try {
      await access(path.join(dir, ".git"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(cwd);
}

function fromRootToCwd(root: string, cwd: string): string[] {
  const start = path.resolve(root);
  const end = path.resolve(cwd);
  const dirs: string[] = [];
  let dir = end;
  const stop = path.parse(start).root;
  while (true) {
    dirs.push(dir);
    if (dir === start || dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}
