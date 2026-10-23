import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NeedsLoginError } from "./oauth.js";
import type { InstallOption, RegistryServer } from "./registry.js";
import type { ServerNamespace } from "./types.js";

/** What a person is asked to approve. */
export type InstallRequest = {
  server: RegistryServer;
  option: InstallOption;
  /** The name it gets in the catalog and the config file. */
  localName: string;
  /** Human-readable summary: publisher, exact command, variables it reads, where it is saved. */
  message: string;
};

export type InstallContext = {
  lookup: (name: string) => Promise<RegistryServer | undefined>;
  /** Connects the server now. `UpstreamPool.add` in the CLI. */
  connect: (spec: ReturnType<InstallOption["spec"]>) => Promise<ServerNamespace>;
  /** Resolve true to go ahead. Throw when nobody can be asked. */
  confirm: (request: InstallRequest) => Promise<boolean>;
  /** Saves the server for the next start. Receives the entry with placeholders, never secret values. */
  persist?: (localName: string, entry: Record<string, unknown>) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Shown in the confirmation. */
  savedTo?: string;
};

export type InstallResult = {
  server: string;
  ident: string;
  methods: string[];
};

/** Install a registry server after a person confirms it, and connect it now. */
export async function installServer(name: string, context: InstallContext): Promise<InstallResult> {
  const server = await context.lookup(name);
  if (!server) throw new Error(`No server named "${name}" in the registry. Use search to find one.`);
  const env = context.env ?? process.env;
  const option = server.install.find((item) => item.needs.every((need) => env[need.name] !== undefined));
  if (!option) {
    const first = server.install[0];
    const missing = first?.needs.filter((need) => env[need.name] === undefined).map((need) => need.name) ?? [];
    throw new Error(
      first
        ? `${name} needs ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in the environment mcptocodemode runs in and try again, or run: npx mcptocodemode add ${name}`
        : `${name} has no package or remote mcptocodemode can run.`,
    );
  }
  const localName = localNameOf(server.name);
  const request: InstallRequest = { server, option, localName, message: describeInstall(server, option, context.savedTo) };
  if (!(await context.confirm(request))) throw new Error(`Installing ${name} was declined.`);

  let namespace: ServerNamespace;
  try {
    namespace = await context.connect(option.spec(localName, env));
  } catch (error) {
    // A remote server that wants an OAuth sign-in is saved anyway, so `login` can find it by name.
    if ((error as { cause?: unknown }).cause instanceof NeedsLoginError) {
      await context.persist?.(localName, configEntry(server, option));
      throw new Error(
        `${server.name} is saved as "${localName}" and needs you to sign in. Run: npx mcptocodemode login ${localName}, then restart the agent.`,
      );
    }
    throw error;
  }
  await context.persist?.(localName, configEntry(server, option));
  return {
    server: namespace.ident,
    ident: namespace.ident,
    methods: namespace.tools.filter((tool) => tool.kind !== "protocol").map((tool) => tool.method),
  };
}

/**
 * `io.github.github/github-mcp-server` becomes `github-mcp-server`. A generic
 * short name takes the publisher's instead, so `com.notion/mcp` and
 * `com.stripe/mcp` become `notion` and `stripe`, not two servers called `mcp`.
 */
export function localNameOf(registryName: string): string {
  const [namespace = "", short = ""] = registryName.split("/");
  if (short && !/^(mcp|mcp-server|server)$/i.test(short)) return short;
  const label = /^io\.github\.(.+)$/i.exec(namespace)?.[1] ?? namespace.split(".")[1] ?? namespace;
  return label || registryName;
}

export function describeInstall(server: RegistryServer, option: InstallOption, savedTo?: string): string {
  const namespace = server.name.split("/")[0];
  const publisher =
    server.publisher === "owner" && server.repository
      ? `${namespace}, which also owns ${server.repository}`
      : `${namespace}${server.repository ? ` (repository ${server.repository}, not verified as theirs)` : ""}`;
  const lines = [
    `Install ${server.name} ${server.version} from the MCP registry?`,
    `Publisher: ${publisher}`,
    `${option.kind === "remote" ? "Connects to" : "Runs"}: ${option.display}`,
  ];
  if (option.needs.length > 0) lines.push(`Reads from your environment: ${option.needs.map((need) => need.name).join(", ")}`);
  if (option.optional?.length) lines.push(`Also reads, when set: ${option.optional.join(", ")}`);
  if (savedTo) lines.push(`Saved to ${savedTo} for next time.`);
  return lines.join("\n");
}

/** The config entry to save: the same server, with `${VAR}` where a secret or variable goes. */
export function configEntry(server: RegistryServer, option: InstallOption): Record<string, unknown> {
  // A needed variable stays `${NAME}`. An optional one is `${NAME:-}`, empty when unset, not the literal text.
  const placeholders = Object.fromEntries([
    ...option.needs.map((need) => [need.name, `\${${need.name}}`]),
    ...(option.optional ?? []).map((name) => [name, `\${${name}:-}`]),
  ]);
  const spec = option.spec(localNameOf(server.name), placeholders);
  const source = { registry: `${server.name}@${server.version}` };
  if (spec.transport === "stdio") {
    return {
      command: spec.command,
      ...(spec.args?.length ? { args: spec.args } : {}),
      ...(spec.env && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
      ...source,
    };
  }
  return { type: spec.transport, url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}), ...source };
}

/** `$XDG_CONFIG_HOME/mcptocodemode/servers.json`, or `~/.config/mcptocodemode/servers.json`. Discovery reads it. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mcptocodemode", "servers.json");
}

/** Remove one server from an `mcpServers` file. Returns its entry, or undefined when it was not there. */
export async function removeServer(file: string, localName: string): Promise<Record<string, unknown> | undefined> {
  let config: { mcpServers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(file, "utf8")) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
  const entry = config.mcpServers?.[localName];
  if (!entry || !config.mcpServers) return undefined;
  delete config.mcpServers[localName];
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return entry;
}

/** Add or replace one server in an `mcpServers` file, keeping everything else in it. */
export async function saveServer(file: string, localName: string, entry: Record<string, unknown>): Promise<void> {
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(file, "utf8")) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
  config.mcpServers = { ...config.mcpServers, [localName]: entry };
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
