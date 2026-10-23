#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultCacheDir, fileCache } from "./cache.js";
import { CodeMode, type CodeModeOptions } from "./codemode.js";
import { configEntry, describeInstall, installServer, localNameOf, removeServer, saveServer, userConfigPath } from "./install.js";
import { openBrowser } from "./oauth.js";
import { availableServer, RegistryClient } from "./registry.js";
import { loadConfigs } from "./config.js";
import { readOnlyPolicy } from "./policy.js";
import { discoverConfig } from "./discover.js";
import { confirmInstall, createCodeModeServer } from "./server.js";
import type { Limits } from "./types.js";
import { login, logout, nestingDepth, SELF_NAME, UpstreamPool } from "./upstream.js";
import { VERSION } from "./version.js";

const command = process.argv[2];

// A failed command prints one line, not a stack trace.
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function fail(error: unknown): never {
  process.stderr.write(`mcptocodemode: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (command === "demo-upstream") {
  await serveDemo();
} else if (command === "serve") {
  await serve();
} else if (command === "sdk" || command === "list") {
  await inspect(command);
} else if (command === "find") {
  await find(process.argv.slice(3).filter((arg) => !arg.startsWith("--")).join(" "));
} else if (command === "index") {
  await index();
} else if (command === "add") {
  await add(process.argv[3]);
} else if (command === "remove") {
  await remove(process.argv[3]);
} else if (command === "login" || command === "logout") {
  await signIn(command, process.argv[3]);
} else {
  // Usage uses the name it was started as: mcptocodemode, or the cm alias.
  const self = commandName();
  process.stderr.write(
    [
      `${self} serve [--config file ...] [--no-cache] [--lazy] [--read-only [--allow server.method ...]] [--registry]`,
      `${self} sdk [--config file ...] [--out api.d.ts]`,
      `${self} list [--config file ...]`,
      `${self} find <words>`,
      `${self} index`,
      `${self} add <registry name> [--yes]`,
      `${self} remove <server>`,
      `${self} login <server> [--port 33418]`,
      `${self} logout <server>`,
      `${self} demo-upstream`,
      "",
      "A config file is this project's JSON, standard mcpServers JSON, or [mcp_servers.*] TOML.",
      "With no --config, serve reads the MCP configs already on this machine.",
      "One upstream that fails to connect is reported and skipped.",
      "serve answers at once. Servers whose tools are cached connect in the background.",
      "--lazy leaves a cached server unlaunched until code calls it.",
      "--read-only refuses methods their server does not mark read-only. --allow makes an exception.",
      "list connects to every server and refreshes the cache.",
      "--registry lets search list servers from the MCP registry and the code install one after you confirm.",
      "find searches the MCP registry. index builds or updates its local copy, which makes find fast.",
      "add saves a registry server to your config, after you confirm.",
      "login signs in to a remote server with OAuth in your browser. serve then uses that sign-in.",
      "",
    ].join("\n"),
  );
  process.exit(command ? 1 : 0);
}

/** `--registry` or `CODEMODE_REGISTRY=1`. Off by default: searching sends the query to the registry. */
function registryOn(): boolean {
  return process.argv.includes("--registry") || process.env.CODEMODE_REGISTRY === "1";
}

/** `--read-only` or `CODEMODE_READ_ONLY=1`. `--allow` alone implies nothing. */
function readOnly(): boolean {
  return process.argv.includes("--read-only") || process.env.CODEMODE_READ_ONLY === "1";
}

function flag(name: string): string | undefined {
  const values = flags(name);
  return values[values.length - 1];
}

function flags(name: string): string[] {
  const values: string[] = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] !== name) continue;
    const value = process.argv[i + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

/**
 * `serve` and `sdk` read the tool cache, so cached servers are not launched
 * up front. `list` connects to every server and rewrites the cache.
 */
async function openPool(
  kind: "serve" | "sdk" | "list",
  extra: (pool: UpstreamPool) => Partial<CodeModeOptions> = () => ({}),
): Promise<{ pool: UpstreamPool; mode: CodeMode }> {
  const configPaths = flags("--config");
  const fromEnv = process.env.CODEMODE_CONFIG;
  if (configPaths.length === 0 && fromEnv) configPaths.push(fromEnv);

  let servers;
  let limits: Limits;
  if (configPaths.length === 0) {
    const discovered = await discoverConfig();
    for (const warning of discovered.warnings) process.stderr.write(`mcptocodemode: ${warning}\n`);
    if (discovered.files.length > 0) {
      process.stderr.write(`mcptocodemode: config ${discovered.files.join(", ")}\n`);
    }
    if (discovered.servers.length === 0) {
      throw new Error(
        "No MCP servers found. Pass --config, or add servers to .mcp.json, mcp.json, or [mcp_servers.*] in a Grok or Codex config.",
      );
    }
    servers = discovered.servers;
    limits = discovered.limits;
  } else {
    const config = await loadConfigs(configPaths);
    servers = config.servers;
    limits = config.limits;
  }

  const useCache = !process.argv.includes("--no-cache") && process.env.CODEMODE_CACHE !== "0";
  const options = {
    cache: useCache ? fileCache(defaultCacheDir()) : undefined,
    prewarm: kind === "serve" && !process.argv.includes("--lazy"),
    onFailure: (failure: { name: string; message: string }) => {
      process.stderr.write(`mcptocodemode: ${failure.name} did not connect: ${failure.message}\n`);
    },
  };
  const pool = kind === "list" ? await UpstreamPool.connect(servers, options) : UpstreamPool.start(servers, options);
  void pool.ready.then(() => {
    const usable = pool.catalog.servers.filter((server) => !server.error);
    const toolCount = usable.reduce(
      (sum, server) => sum + server.tools.filter((tool) => tool.kind !== "protocol").length,
      0,
    );
    const waiting = usable.length - pool.connected.length;
    const cached = waiting > 0 ? `, ${waiting} from cache` : "";
    process.stderr.write(`mcptocodemode: ${pool.connected.length} connected${cached}, ${toolCount} tools\n`);
  });
  const mode: CodeMode = new CodeMode(pool.catalog, (call) => pool.call(call, limits.maxResultChars, mode.blobs), {
    limits,
    beforeCall: readOnly() ? readOnlyPolicy(pool.catalog, { allow: flags("--allow") }) : undefined,
    ...extra(pool),
  });
  return { pool, mode };
}

async function serve(): Promise<void> {
  if (nestingDepth(process.env) > 0) {
    // A client config that lists this server is read again by discovery.
    // Answer the handshake with nothing else, so the parent recognizes its
    // own entry and drops it instead of launching servers or reporting a failure.
    await new McpServer({ name: SELF_NAME, version: VERSION }).connect(new StdioServerTransport());
    return;
  }
  // Created after the CodeMode, which needs it to ask the person at the client.
  let server: ReturnType<typeof createCodeModeServer> | undefined;
  const registry = registryOn() ? registryClient() : undefined;
  if (registry) {
    // The first sync downloads the whole registry. Search says so until it is done.
    void registry.sync().catch((error: unknown) => {
      process.stderr.write(`mcptocodemode: registry sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  const saveTo = userConfigPath();
  const { pool, mode } = await openPool("serve", (pool) =>
    registry
      ? {
          discover: async (query) => (await registry.search(query)).map((item) => availableServer(item)),
          install: (name) =>
            installServer(name, {
              lookup: (lookupName) => registry.get(lookupName),
              connect: (spec) => pool.add(spec),
              confirm: (request) => {
                if (!server) throw new Error("The MCP connection is not ready yet");
                return confirmInstall(server, request);
              },
              persist: (localName, entry) => saveServer(saveTo, localName, entry),
              savedTo: saveTo,
            }),
        }
      : {},
  );
  server = createCodeModeServer(mode, { ready: pool.ready, readOnly: readOnly(), registry: registry !== undefined });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    mode.close();
    await pool.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  await server.connect(transport);
}

/** A registry client with its local index in the cache directory. */
function registryClient(options: { syncOnSearch?: boolean } = {}): RegistryClient {
  return new RegistryClient({ indexFile: path.join(defaultCacheDir(), "registry-index.json"), ...options });
}

async function find(query: string): Promise<void> {
  if (!query) throw new Error("usage: mcptocodemode find <words>");
  // A one-off search should not keep the process alive building the index. `index` does that.
  const registry = registryClient({ syncOnSearch: false });
  if (await registry.hasIndex()) {
    // Fetching what changed since the last sync takes a second.
    await registry.sync().catch(() => undefined);
  } else {
    process.stderr.write(
      `mcptocodemode: no local index yet, so this asks the registry directly, which can take 20 to 40 seconds. Run "${commandName()} index" once (about a minute) to make find instant.\n`,
    );
  }
  const results = await registry.search(query, 10);
  if (results.length === 0) process.stdout.write(`No registry servers match "${query}".\n`);
  for (const item of results.map((server) => availableServer(server))) {
    process.stdout.write(`${item.name} ${item.version}${item.publisher === "owner" ? "  (publisher owns the repository)" : ""}\n`);
    if (item.description) process.stdout.write(`  ${item.description}\n`);
    process.stdout.write(`  ${item.runs}\n`);
    if (item.needs.length > 0) process.stdout.write(`  needs ${item.needs.join(", ")}${item.ready ? "" : " (not set)"}\n`);
  }
}

/** Build or update the local registry index, with progress. */
async function index(): Promise<void> {
  const registry = registryClient();
  const fresh = !(await registry.hasIndex());
  if (fresh) process.stderr.write("mcptocodemode: downloading the MCP registry, about 48,000 servers. This takes a few minutes.\n");
  let last = Date.now();
  const result = await registry.sync((count) => {
    if (Date.now() - last > 5_000) {
      process.stderr.write(`mcptocodemode: ${count} servers so far\n`);
      last = Date.now();
    }
  });
  process.stdout.write(result.full ? `Indexed ${result.servers} servers.\n` : `Index is up to date: ${result.servers} servers.\n`);
}

function commandName(): string {
  return path.basename(process.argv[1] ?? "mcptocodemode").replace(/\.js$/, "") === "cm" ? "cm" : "mcptocodemode";
}

/** Save a registry server to the user config after a person confirms in the terminal. Nothing runs yet. */
async function add(name: string | undefined): Promise<void> {
  if (!name || name.startsWith("--")) throw new Error("usage: mcptocodemode add <registry name> [--yes]");
  const server = await registryClient().get(name);
  if (!server) throw new Error(`No server named "${name}" in the registry. Try: mcptocodemode find <words>`);
  const option = server.install.find((item) => item.needs.every((need) => process.env[need.name] !== undefined)) ?? server.install[0];
  if (!option) throw new Error(`${name} has no package or remote mcptocodemode can run.`);
  const file = userConfigPath();
  process.stdout.write(`${describeInstall(server, option, file)}\n`);
  if (!process.argv.includes("--yes")) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Save it? [y/N] ");
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write("Nothing saved.\n");
      return;
    }
  }
  await saveServer(file, localNameOf(server.name), configEntry(server, option));
  process.stdout.write(`Saved as "${localNameOf(server.name)}" in ${file}. Restart your agent to load it.\n`);
  if (option.kind === "remote" && option.needs.length === 0) {
    process.stdout.write(`If it asks you to sign in, run: npx mcptocodemode login ${localNameOf(server.name)}\n`);
  }
  const missing = option.needs.filter((need) => process.env[need.name] === undefined).map((need) => need.name);
  if (missing.length > 0) {
    process.stdout.write(`Set ${missing.join(", ")} in the environment your agent starts mcptocodemode with. The config reads ${missing.map((item) => `\${${item}}`).join(", ")}.\n`);
  }
}

/** Take a server out of the config `add` writes, and forget its sign-in. */
async function remove(name: string | undefined): Promise<void> {
  if (!name || name.startsWith("--")) throw new Error("usage: mcptocodemode remove <server>");
  const file = userConfigPath();
  const entry = await removeServer(file, name);
  if (!entry) throw new Error(`No server named "${name}" in ${file}. remove only edits the servers add saved.`);
  if (typeof entry.url === "string") logout({ name, transport: "http", url: entry.url });
  process.stdout.write(`Removed ${name} from ${file}${typeof entry.url === "string" ? " and forgot its sign-in" : ""}. Restart your agent to drop it.\n`);
}

/** The configured server called `name`, from --config or discovery. */
async function configuredServer(name: string) {
  const configPaths = flags("--config");
  if (configPaths.length === 0 && process.env.CODEMODE_CONFIG) configPaths.push(process.env.CODEMODE_CONFIG);
  const servers = configPaths.length > 0 ? (await loadConfigs(configPaths)).servers : (await discoverConfig()).servers;
  const spec = servers.find((server) => server.name === name);
  if (!spec) {
    throw new Error(`No configured server named "${name}". Configured: ${servers.map((server) => server.name).join(", ") || "none"}`);
  }
  return spec;
}

async function signIn(kind: "login" | "logout", name: string | undefined): Promise<void> {
  if (!name || name.startsWith("--")) throw new Error(`usage: mcptocodemode ${kind} <server>`);
  const spec = await configuredServer(name);
  if (kind === "logout") {
    logout(spec);
    process.stdout.write(`Forgot the sign-in for ${name}.\n`);
    return;
  }
  const port = flag("--port");
  const result = await login(spec, {
    port: port ? Number(port) : undefined,
    open: (url) => {
      process.stdout.write(`Opening your browser to sign in to ${name}. If it does not open, visit:\n${url}\n`);
      openBrowser(url);
    },
  });
  process.stdout.write(
    result.alreadySignedIn
      ? `Already signed in to ${name}. ${result.tools} tools.\n`
      : `Signed in to ${name}. ${result.tools} tools. Restart your agent to use it.\n`,
  );
}

async function inspect(kind: "sdk" | "list"): Promise<void> {
  const { pool, mode } = await openPool(kind);
  try {
    await pool.ready;
    if (kind === "list") {
      for (const server of mode.catalog.servers) {
        if (server.error) {
          process.stdout.write(`${server.ident} (did not connect: ${server.error})\n`);
          continue;
        }
        const tools = server.tools.filter((tool) => tool.kind !== "protocol");
        process.stdout.write(`${server.ident} (${tools.length})\n`);
        for (const tool of tools) process.stdout.write(`  ${tool.method}\n`);
      }
      return;
    }
    const typescript = mode.sdk();
    const out = flag("--out");
    if (out) {
      await writeFile(out, typescript);
      process.stderr.write(`Wrote ${out}\n`);
    } else {
      process.stdout.write(typescript);
    }
  } finally {
    mode.close();
    await pool.close();
  }
}

async function serveDemo(): Promise<void> {
  const server = new McpServer({ name: "notes", version: VERSION });
  const notes = [
    { id: "1", title: "Buy milk", body: "Whole milk." },
    { id: "2", title: "Ship codemode", body: "Three tools, every upstream server." },
  ];
  server.registerTool(
    "list",
    {
      description: "List notes. Returns id and title.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = notes.map(({ id, title }) => ({ id, title }));
      return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
    },
  );
  server.registerTool(
    "get",
    {
      description: "Read one note by id.",
      inputSchema: { id: z.string().describe("Note id from list.") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const note = notes.find((item) => item.id === id);
      if (!note) {
        return { isError: true, content: [{ type: "text" as const, text: `No note ${id}` }] };
      }
      return {
        structuredContent: note,
        content: [{ type: "text" as const, text: JSON.stringify(note) }],
      };
    },
  );
  server.registerResource(
    "note",
    "note://1",
    { description: "The first note.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(notes[0]) }],
    }),
  );
  server.registerPrompt(
    "summarize",
    { description: "Ask for a summary of one note.", argsSchema: { id: z.string() } },
    async ({ id }) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Summarize note ${id}` } }],
    }),
  );
  await server.connect(new StdioServerTransport());
}
