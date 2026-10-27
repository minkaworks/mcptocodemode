import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "./config.js";

/** The name MCPtoCodeMode is registered under in every agent. */
export const AGENT_SERVER_NAME = "codemode";

export type AgentEnvironment = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/** One coding agent MCPtoCodeMode can be added to. */
export type AgentTarget = {
  id: string;
  name: string;
  /** Where the entry lands, shown before anything changes. */
  where: string;
  /** How the change is made: the agent's own command, or an edit to its file. */
  method: string;
  detected: boolean;
  /** Whether a server named `codemode` is already there. */
  added: boolean;
  add(command: string, args: string[]): Promise<void>;
  remove(): Promise<void>;
};

type Context = Required<AgentEnvironment>;

/** Every agent this knows, with whether it is on this machine and already has `codemode`. */
export async function detectAgents(options: AgentEnvironment = {}): Promise<AgentTarget[]> {
  const context: Context = { home: options.home ?? os.homedir(), env: options.env ?? process.env, platform: options.platform ?? process.platform };
  return Promise.all([claudeCode(context), codex(context), cursor(context), grok(context), openCode(context), pi(context), claudeDesktop(context)]);
}

async function claudeCode(context: Context): Promise<AgentTarget> {
  const file = path.join(context.home, ".claude.json");
  const added = await hasServer(file);
  const run = (args: string[]) => runTool(context, "claude", args);
  return {
    id: "claude-code",
    name: "Claude Code",
    where: `${tilde(file, context)}, user scope`,
    method: "claude mcp add",
    detected: (await onPath(context, "claude")) !== undefined,
    added,
    async add(command, args) {
      if (await hasServer(file)) await run(["mcp", "remove", "-s", "user", AGENT_SERVER_NAME]);
      await run(["mcp", "add", "-s", "user", AGENT_SERVER_NAME, "--", command, ...args]);
    },
    async remove() {
      await run(["mcp", "remove", "-s", "user", AGENT_SERVER_NAME]);
    },
  };
}

async function codex(context: Context): Promise<AgentTarget> {
  const file = path.join(context.home, ".codex", "config.toml");
  const run = (args: string[]) => runTool(context, "codex", args);
  return {
    id: "codex",
    name: "Codex",
    where: tilde(file, context),
    method: "codex mcp add",
    detected: (await onPath(context, "codex")) !== undefined,
    added: await hasServer(file),
    async add(command, args) {
      if (await hasServer(file)) await run(["mcp", "remove", AGENT_SERVER_NAME]);
      await run(["mcp", "add", AGENT_SERVER_NAME, "--", command, ...args]);
    },
    async remove() {
      await run(["mcp", "remove", AGENT_SERVER_NAME]);
    },
  };
}

async function grok(context: Context): Promise<AgentTarget> {
  const file = path.join(context.home, ".grok", "config.toml");
  const run = (args: string[]) => runTool(context, "grok", args);
  return {
    id: "grok",
    name: "Grok",
    where: tilde(file, context),
    method: "grok mcp add",
    detected: (await onPath(context, "grok")) !== undefined,
    added: await hasServer(file),
    // `grok mcp add` adds or updates.
    async add(command, args) {
      await run(["mcp", "add", AGENT_SERVER_NAME, command, "--", ...args]);
    },
    async remove() {
      await run(["mcp", "remove", AGENT_SERVER_NAME]);
    },
  };
}

async function pi(context: Context): Promise<AgentTarget> {
  const file = path.join(context.home, ".pi", "agent", "mcp.json");
  const run = (args: string[]) => runTool(context, "pi", args);
  return {
    id: "pi",
    name: "Pi",
    where: tilde(file, context),
    method: "pi mcp add",
    detected: (await onPath(context, "pi")) !== undefined,
    added: await hasServer(file),
    // `pi mcp add` adds or replaces.
    async add(command, args) {
      await run(["mcp", "add", AGENT_SERVER_NAME, "--", command, ...args]);
    },
    async remove() {
      await run(["mcp", "remove", AGENT_SERVER_NAME]);
    },
  };
}

async function openCode(context: Context): Promise<AgentTarget> {
  const dir = path.join(context.env.XDG_CONFIG_HOME || path.join(context.home, ".config"), "opencode");
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  const file = (await exists(jsonc)) && !(await exists(json)) ? jsonc : json;
  return {
    id: "opencode",
    name: "OpenCode",
    where: tilde(file, context),
    method: "opencode mcp add",
    detected: (await onPath(context, "opencode")) !== undefined,
    added: (await hasServer(json)) || (await hasServer(jsonc)),
    async add(command, args) {
      // OpenCode has no `mcp remove`, so an update removes the old entry from the file first.
      if (await hasServer(file)) await editJson(file, ["mcp", AGENT_SERVER_NAME], undefined);
      await runTool(context, "opencode", ["mcp", "add", "--global", AGENT_SERVER_NAME, "--", command, ...args]);
    },
    async remove() {
      await editJson(file, ["mcp", AGENT_SERVER_NAME], undefined);
    },
  };
}

async function cursor(context: Context): Promise<AgentTarget> {
  const file = path.join(context.home, ".cursor", "mcp.json");
  return {
    id: "cursor",
    name: "Cursor",
    where: tilde(file, context),
    method: "edits the file",
    detected:
      (await exists(path.join(context.home, ".cursor"))) ||
      (await onPath(context, "cursor")) !== undefined ||
      (await onPath(context, "cursor-agent")) !== undefined,
    added: await hasServer(file),
    async add(command, args) {
      await editJson(file, ["mcpServers", AGENT_SERVER_NAME], { command, args });
    },
    async remove() {
      await editJson(file, ["mcpServers", AGENT_SERVER_NAME], undefined);
    },
  };
}

async function claudeDesktop(context: Context): Promise<AgentTarget> {
  const dir =
    context.platform === "darwin"
      ? path.join(context.home, "Library", "Application Support", "Claude")
      : context.platform === "win32"
        ? path.join(context.env.APPDATA ?? path.join(context.home, "AppData", "Roaming"), "Claude")
        : path.join(context.home, ".config", "Claude");
  const file = path.join(dir, "claude_desktop_config.json");
  return {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: tilde(file, context),
    method: "edits the file",
    detected: await exists(dir),
    added: await hasServer(file),
    async add(command, args) {
      await editJson(file, ["mcpServers", AGENT_SERVER_NAME], { command, args });
    },
    async remove() {
      await editJson(file, ["mcpServers", AGENT_SERVER_NAME], undefined);
    },
  };
}

/** Whether a config file lists a server called `codemode`, in any format the discovery reads. */
async function hasServer(file: string): Promise<boolean> {
  try {
    const parsed = parseConfig(await readFile(file, "utf8"), file, {});
    return parsed.servers.some((server) => server.name === AGENT_SERVER_NAME);
  } catch {
    return false;
  }
}

/**
 * Set or delete one key in a JSON config, after copying the file to
 * `<file>.mcptocodemode.bak`. A file with comments is left alone, since
 * rewriting it would drop them.
 */
export async function editJson(file: string, keyPath: [string, string], value: unknown): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let config: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      config = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not plain JSON (it may have comments). Edit it by hand: ${keyPath.join(".")}`);
    }
    await copyFile(file, `${file}.mcptocodemode.bak`);
  }
  const [group, key] = keyPath;
  const servers = { ...(config[group] as Record<string, unknown> | undefined) };
  if (value === undefined) delete servers[key];
  else servers[key] = value;
  config[group] = servers;
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const mode = text ? (await stat(file)).mode & 0o777 : 0o600;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  await rename(temp, file);
}

/** The absolute path of `command` on PATH, or undefined. */
export async function onPath(context: Pick<Context, "env" | "platform">, command: string): Promise<string | undefined> {
  const dirs = (context.env.PATH ?? "").split(context.platform === "win32" ? ";" : ":").filter(Boolean);
  const names = context.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A regular executable file, following symlinks. Does not launch it. */
export async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run an agent's own CLI. A failure carries the first line it printed. */
async function runTool(context: Context, command: string, args: string[]): Promise<void> {
  const binary = await onPath(context, command);
  if (!binary) throw new Error(`${command} is not on PATH`);
  await new Promise<void>((resolve, reject) => {
    execFile(binary, args, { env: context.env, timeout: 60_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const line = `${stderr}`.split("\n").find((text) => text.trim()) ?? error.message;
      reject(new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${line.trim()}`));
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function tilde(file: string, context: Context): string {
  return file.startsWith(context.home) ? `~${file.slice(context.home.length)}` : file;
}
