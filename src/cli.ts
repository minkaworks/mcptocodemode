#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { CodeMode } from "./codemode.js";
import { loadConfigs } from "./config.js";
import { discoverConfig } from "./discover.js";
import { createCodeModeServer } from "./server.js";
import type { Limits } from "./types.js";
import { nestingDepth, UpstreamPool } from "./upstream.js";
import { VERSION } from "./version.js";

const command = process.argv[2];

if (command === "demo-upstream") {
  await serveDemo();
} else if (command === "serve") {
  await serve();
} else if (command === "sdk" || command === "list") {
  await inspect(command);
} else {
  process.stderr.write(
    [
      "mcptocodemode serve [--config file ...]",
      "mcptocodemode sdk [--config file ...] [--out api.d.ts]",
      "mcptocodemode list [--config file ...]",
      "mcptocodemode demo-upstream",
      "",
      "A config file is this project's JSON, standard mcpServers JSON, or [mcp_servers.*] TOML.",
      "With no --config, serve reads the MCP configs already on this machine.",
      "One upstream that fails to connect is reported and skipped.",
      "",
    ].join("\n"),
  );
  process.exit(command ? 1 : 0);
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

async function openPool(): Promise<{ pool: UpstreamPool; mode: CodeMode }> {
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

  const pool = await UpstreamPool.connect(servers);
  for (const failure of pool.failures) {
    process.stderr.write(`mcptocodemode: ${failure.name} did not connect: ${failure.message}\n`);
  }
  const connected = pool.catalog.servers.filter((server) => !server.error);
  const toolCount = connected.reduce(
    (sum, server) => sum + server.tools.filter((tool) => tool.kind !== "protocol").length,
    0,
  );
  process.stderr.write(`mcptocodemode: ${connected.length} connected, ${toolCount} tools\n`);
  const mode = new CodeMode(pool.catalog, (call) => pool.call(call, limits.maxResultChars), { limits });
  return { pool, mode };
}

async function serve(): Promise<void> {
  if (nestingDepth(process.env) > 0) {
    // A client config that lists this server is read again by discovery.
    // Without this exit, every child would launch the next one.
    process.stderr.write(
      "mcptocodemode: not starting inside another mcptocodemode. A config it read lists mcptocodemode itself; that entry is skipped.\n",
    );
    process.exit(1);
  }
  const { pool, mode } = await openPool();
  const server = createCodeModeServer(mode);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
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

async function inspect(kind: "sdk" | "list"): Promise<void> {
  const { pool, mode } = await openPool();
  try {
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
