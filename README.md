# MCPtoCodeMode

[Specification](SPEC.md) · [Benchmarks](REPORT.md) · [CI](https://github.com/minkaworks/mcptocodemode/actions/workflows/ci.yml) · [MIT License](LICENSE) · [Changelog](CHANGELOG.md)

One MCP server in front of all the MCP servers you already use. Your model sees three tools instead of hundreds, and it writes one short program instead of making dozens of tool calls.

```bash
npx -y mcptocodemode list
```

That finds the MCP servers already configured on your machine (Claude, Codex, Cursor, VS Code, Grok), connects to them, and prints what the model will be able to call.

## Why

Connect seven MCP servers and your client puts 55 tool definitions in every prompt. Then ask it something like *"read these 25 order files and total the paid ones"*. That is 26 tool calls and 26 model turns, and each turn re-reads every file that came before it.

With MCPtoCodeMode the model writes this once, and only the answer comes back:

```js
const listing = await filesystem.list_directory({ path: "/data/orders" });
const names = listing.content.split("\n").map((line) => line.replace("[FILE] ", ""));
const orders = await Promise.all(
  names.map(async (name) => JSON.parse((await filesystem.read_text_file({ path: `/data/orders/${name}` })).content)),
);
const paid = orders.filter((order) => order.status === "paid");
return { paid: paid.length, total: paid.reduce((sum, order) => sum + order.total, 0) };
```

The code runs in a sandbox with no network, no filesystem, and no credentials. Its only way out is the MCP servers you configured.

## Benchmarks

Seven official [reference servers](https://github.com/modelcontextprotocol/servers), 55 tools, measured with `pnpm measure`. Method, raw data, and caveats are in [REPORT.md](REPORT.md).

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Tool definitions in every prompt | 31,179 bytes | **2,581 bytes** |
| Count errors in a 2,000-line log: bytes back to the model | 129,977 | **402** |
| Total 25 order files: model turns | 26 | **1** |
| Total 25 order files: context re-read across turns | 172,698 bytes | **1,822 bytes** |
| Startup: first `search` answered, tools cached | 1,697 ms (v0.1.1) | **314 ms** |

The 2,581 bytes stay the same however many servers you add. MCPtoCodeMode does not make the servers themselves faster. It cuts what goes into the prompt and the turns between calls. No model was in the loop for these numbers.

## Use it

Claude Code:

```bash
claude mcp add codemode -- npx -y mcptocodemode serve
```

Any other MCP client:

```json
{
  "mcpServers": {
    "codemode": { "command": "npx", "args": ["-y", "mcptocodemode", "serve"] }
  }
}
```

You can leave your other servers configured. MCPtoCodeMode reads those same configs and skips its own entry. Remove the other servers from the client if you want the model to see only the three tools.

## How it works

The model gets three tools:

- **`search`** finds methods by keyword. The top hits include their TypeScript signature.
- **`describe`** returns the full signature of a server (`"notes"`) or one method (`"notes.get"`).
- **`execute`** runs JavaScript. Each server is a global: `await notes.get({ id: "1" })`. Only the return value comes back, plus `console.log` output and a list of which methods ran.

Every server also has `resources.list`, `resources.read`, `resources.templates`, `prompts.list`, and `prompts.get`. Inside `execute`, `codemode.search` and `codemode.describe` work too. The full contract is [SPEC.md](SPEC.md).

## Configuration

With no flags, `serve` reads the MCP configs on your machine, in this order. A later server with the same name wins.

- `~/.codex/config.toml`, Claude Desktop, `~/.claude.json` (including the servers Claude Code stores for this project), `~/.cursor/mcp.json`, `~/.grok/config.toml`
- from the git root down to the current directory: `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.grok/config.toml`
- `./mcptocodemode.config.json`

It accepts standard `mcpServers` JSON, VS Code `servers` JSON, and Codex or Grok `[mcp_servers.name]` TOML, over stdio, streamable HTTP, or SSE. `${VAR}` and `${VAR:-default}` expand from the environment.

| Option | Effect |
| --- | --- |
| `--config file` | Use only these files. Repeatable. `CODEMODE_CONFIG` sets one. |
| `--lazy` | Don't launch a cached server until code calls it. |
| `--no-cache` | Don't read or write the tool cache. Same as `CODEMODE_CACHE=0`. |
| `CODEMODE_CACHE_DIR` | Where tool lists are cached. Default `~/.cache/mcptocodemode`. |

Servers connect in parallel. One that fails, or doesn't answer within 60 seconds, is skipped and the rest load. Tool lists are cached after each connect, so the next start answers at once and the servers connect in the background. A cache entry is keyed by a hash of the server config, and credentials are never written. `mcptocodemode list` refreshes the cache. `mcptocodemode sdk --out api.d.ts` writes the TypeScript the sandbox implements.

## Library

```ts
import { catalogFromServers, CodeMode } from "mcptocodemode";

const catalog = catalogFromServers([
  { name: "notes", tools: [{ name: "get", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] },
]);
const mode = new CodeMode(catalog, async (call) => ({ id: call.input.id, title: "Buy milk" }));

await mode.execute(`return await notes.get({ id: "1" });`);
```

`beforeCall` can refuse a method before it runs. `createCodeModeServer(mode)` turns it into an MCP server, and `UpstreamPool` connects to real servers.

## Limits and safety

Each `execute` gets a fresh [QuickJS](https://github.com/quickjs-ng/quickjs) WebAssembly sandbox: 30 seconds, 100 tool calls, 64 MiB, and 100,000 characters of code. Tool results over 200,000 characters come back truncated. Images, audio, and binary resources are not copied in.

The sandbox limits what the code can reach. It does not limit what a tool does: a tool that sends an email still sends it. Use `beforeCall` to block methods that need a human.

## Contributing

Setup and tests: [CONTRIBUTING.md](CONTRIBUTING.md). Questions: [SUPPORT.md](SUPPORT.md). Vulnerabilities: [SECURITY.md](SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This repository follows and defines the [minkaworks repository standard](STANDARD.md).

The idea comes from [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/). This project speaks plain MCP, so any MCP client can use it.
