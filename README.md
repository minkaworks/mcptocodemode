# MCPtoCodeMode

One MCP server in front of every MCP server you already run. The model sees three tools: `search`, `describe`, and `execute`. It writes JavaScript. The code calls the real servers from a sandbox that has no network and no credentials.

MCP is the standard, so this server does not special-case any product. A stdio process, a streamable HTTP endpoint, and a legacy SSE endpoint all show up the same way: tools, resources, and prompts. The contract is [SPEC.md](SPEC.md). The idea of letting the model write code against those tools comes from [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/). The wire interface here is MCP, so any MCP client can host it.

A client that forwards every upstream tool can put a couple of hundred tools in the prompt. This server keeps that count at 3, however many servers connect later.

## Run

```bash
pnpm install
pnpm test
pnpm build
node dist/cli.js serve --config mcptocodemode.config.example.json
```

`mcptocodemode.reference.example.json` points at the official servers in [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers): everything, filesystem, memory, sequential thinking, time, git, and fetch. They are published from that repository and need no API key. Set `CODEMODE_FS_ROOT` to a directory the filesystem server may touch, `CODEMODE_MEMORY_FILE` to a `.jsonl` path, and `CODEMODE_GIT_REPO` to a repository. Fetch refuses private addresses unless you add `--allow-private-ips`. Git can change that repository when the code calls `git_add` or `git_commit`.

[REPORT.md](REPORT.md) compares flat MCP, an inline SDK, and progressive Code Mode on those seven servers. `pnpm measure` repeats the run.

With no `--config`, `serve` reads the MCP configs already on the machine. It does not contact a registry and it does not invent servers. It looks at, in order:

- `~/.codex/config.toml`, Claude Desktop, `~/.claude.json`, `~/.cursor/mcp.json`, `~/.grok/config.toml`
- from the git root down to the working directory: `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.grok/config.toml`
- `./mcptocodemode.config.json`

A later file replaces an earlier server with the same name. Pass `--config` one or more times to use only those files. `CODEMODE_CONFIG` is a single file when `--config` is absent.

Accepted files:

- this project's `{ "servers": [ { "name", "command" | "url" } ] }`
- standard `{ "mcpServers": { "name": { "command" | "url", "type": "stdio" | "http" | "sse" } } }`
- VS Code `{ "servers": { "name": { ... } } }`
- Grok and Codex `[mcp_servers.name]` TOML

`type` may be `stdio`, `http`, `streamable-http`, or `sse`. A URL with no type uses streamable HTTP. `enabled = false` and `disabled_mcp_servers` skip a server. `${VAR}` and `${VAR:-default}` expand from the environment of this process.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/notes"]
    },
    "docs": {
      "type": "sse",
      "url": "https://example.com/sse",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

`${VAR}` expands from the environment of this process. A name that is unset stays as written. Do not commit secrets.

One server that fails to connect is reported on stderr and skipped. The others still load. Search lists the failure. Restart to pick up tools added after connect.

Grok, or any other MCP client:

```toml
[mcp_servers.codemode]
command = "node"
args = ["/absolute/path/to/mcptocodemode/dist/cli.js", "serve", "--config", "/absolute/path/to/mcptocodemode.config.json"]
```

`node dist/cli.js list` prints each namespace. `node dist/cli.js sdk --out api.d.ts` writes the TypeScript the sandbox implements. `node dist/cli.js demo-upstream` is a tiny notes server with a tool, a resource, and a prompt.

## What the model does

`search` returns a few matches and the list of servers. It does not return schemas. An empty query still lists the servers.

`describe` with `"notes.get"` returns that signature. `"notes.resources.read"` and `"notes.prompts.get"` describe the protocol methods. The first dot separates the server from the rest.

`execute` runs code like this:

```js
const rows = await notes.list();
const full = [];
for (const row of rows) {
  full.push(await notes.get({ id: row.id }));
}
const memo = await notes.resources.read({ uri: "note://1" });
return { titles: full.map((note) => note.title), memo };
```

Every connected server has `resources.list`, `resources.read`, `resources.templates`, `prompts.list`, and `prompts.get`. They call the MCP resources and prompts methods. A server that does not implement them returns that server's error when the code calls them. Nothing is probed at connect.

Only the return value comes back. `console.log` is collected into `logs`. `calls` says which methods ran, not what they were given.

Inside the sandbox, `codemode.search` and `codemode.describe` do the same work, so a single `execute` can look a method up and call it.

## Library

```ts
import { catalogFromServers, CodeMode } from "mcptocodemode";

const catalog = catalogFromServers([
  {
    name: "notes",
    tools: [{ name: "get", description: "Read one note.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
  },
]);

const mode = new CodeMode(catalog, async (call) => {
  // call.server, call.method, call.tool, call.input
  return { id: "1", title: "Buy milk" };
});

await mode.execute(`return await notes.get({ id: "1" });`);
```

`beforeCall` can reject a method before the dispatcher runs. `createCodeModeServer(mode)` is the MCP adapter. `parseConfig` and `discoverConfig` read the standard files. `UpstreamPool.connect` speaks stdio, streamable HTTP, and SSE.

## Limits

The sandbox is [QuickJS](https://github.com/quickjs-ng/quickjs) compiled to WebAssembly, one context per `execute`. Defaults: 30 seconds, 100 tool calls, 64 MiB, 100,000 characters of code. Tool results over 200,000 characters of JSON come back as `{ truncated: true, bytes, preview }`. Image and audio blocks are not copied in. Resource blobs are not copied in either.

These are process limits, not a substitute for upstream authorization. A tool that sends a message still sends it when the code calls it. Deny that method in `beforeCall` when a human has to approve it.
