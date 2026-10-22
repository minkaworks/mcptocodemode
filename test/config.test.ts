import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigs, parseConfig } from "../src/config.js";
import { discoverConfig } from "../src/discover.js";

describe("standard MCP config", () => {
  it("reads mcpServers JSON, SSE, and skips disabled servers", () => {
    const parsed = parseConfig(
      `{
        // comment, trailing comma
        "mcpServers": {
          "docs": { "type": "sse", "url": "https://example.com/sse", "headers": { "Authorization": "Bearer \${TOKEN:-demo}" } },
          "off": { "command": "nope", "enabled": false },
          "files": { "command": "npx", "args": ["-y", "server"], }
        },
      }`,
      "mcp.json",
      { TOKEN: "s3cret" },
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.servers.map((server) => server.name)).toEqual(["docs", "files"]);
    expect(parsed.servers[0]).toMatchObject({
      transport: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(parsed.servers[1]).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "server"] });
  });

  it("reads Grok and Codex mcp_servers TOML", () => {
    const parsed = parseConfig(
      `
disabled_mcp_servers = ["hidden"]

[mcp_servers.notes]
command = "node"
args = ["dist/cli.js", "demo-upstream"]

[mcp_servers.docs]
url = "https://example.com/mcp"
type = "http"

[mcp_servers.docs.headers]
Authorization = "Bearer \${TOKEN:-demo}"

[mcp_servers.off]
command = "nope"
enabled = false

[mcp_servers.hidden]
command = "nope"
`,
      "config.toml",
      {},
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.servers.map((server) => [server.name, server.transport])).toEqual([
      ["notes", "stdio"],
      ["docs", "http"],
    ]);
    expect(parsed.servers[1]?.headers).toEqual({ Authorization: "Bearer demo" });
  });

  it("keeps this project's servers array and rejects a server with both transports", () => {
    const parsed = parseConfig(
      JSON.stringify({
        servers: [
          { name: "notes", command: "node", args: ["demo"] },
          { name: "both", command: "node", url: "https://example.com/mcp" },
        ],
        limits: { maxCalls: 4 },
      }),
      "mcptocodemode.config.json",
    );
    expect(parsed.servers.map((server) => server.name)).toEqual(["notes"]);
    expect(parsed.limits).toEqual({ maxCalls: 4 });
    expect(parsed.issues[0]).toContain('exactly one of "command" or "url"');
  });

  it("lets a later file replace a server with the same name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codemode-config-"));
    const first = path.join(dir, "a.json");
    const second = path.join(dir, "b.json");
    await writeFile(first, JSON.stringify({ mcpServers: { notes: { command: "old" } } }));
    await writeFile(second, JSON.stringify({ servers: [{ name: "notes", command: "new" }] }));
    const config = await loadConfigs([first, second]);
    expect(config.servers).toEqual([{ name: "notes", command: "new", transport: "stdio" }]);
  });
});

describe("discovery", () => {
  it("merges home and project configs without launching them", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codemode-home-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "codemode-cwd-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(cwd, ".vscode"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.remote]\nurl = "https://example.com/mcp"\n',
    );
    await writeFile(
      path.join(cwd, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { local: { command: "node", args: ["server.js"] } } }),
    );
    await writeFile(path.join(cwd, "mcp.json"), "{ this is not json");
    const found = await discoverConfig({ cwd, home, platform: "linux", env: {} });
    expect(found.servers.map((server) => server.name)).toEqual(["remote", "local"]);
    expect(found.warnings.some((warning) => warning.includes("mcp.json"))).toBe(true);
    expect(found.files.some((file) => file.endsWith("config.toml"))).toBe(true);
    expect(JSON.stringify(found)).not.toContain("Bearer");
  });

  it("reads Claude Code servers stored for this project in ~/.claude.json", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codemode-home-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "codemode-cwd-"));
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { user: { command: "user-server" } },
        projects: {
          [path.resolve(cwd)]: { mcpServers: { local: { type: "http", url: "https://example.com/mcp" } } },
          "/somewhere/else": { mcpServers: { other: { command: "nope" } } },
        },
      }),
    );
    const found = await discoverConfig({ cwd, home, platform: "linux", env: {} });
    expect(found.servers.map((server) => server.name)).toEqual(["user", "local"]);
  });
});
