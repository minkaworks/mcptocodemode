# MCPtoCodeMode

[Specification](SPEC.md) · [Benchmarks](REPORT.md) · [CI](https://github.com/minkaworks/mcptocodemode/actions/workflows/ci.yml) · [MIT License](LICENSE) · [Changelog](CHANGELOG.md)

One MCP server in front of all the MCP servers you already use. Your model sees three tools instead of hundreds, and it writes one short program instead of making dozens of tool calls.

```bash
npx -y mcptocodemode list
```

That finds the MCP servers already configured on your machine (Claude Code, Codex, Cursor, Grok, OpenCode, Pi, VS Code), connects to them, and prints what the model will be able to call.

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

Seven official [reference servers](https://github.com/modelcontextprotocol/servers), 55 tools. Method, raw data, and caveats are in [REPORT.md](REPORT.md).

With Claude Sonnet 5.5 doing three real tasks, three runs each, through OpenRouter:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers | 9 / 9 | 9 / 9 |
| Input tokens | 520,581 | **92,406** (5.6× fewer) |
| Cost | $1.086 | **$0.219** (5× less) |
| Tokens to count errors in a 2,000-line log | 101,244 | **8,093** |
| Model turns | 21 | 29 |

Same answers, a fifth of the cost. It takes a few more turns: the model usually searches once before it writes the program.

Without a model in the loop:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Tool definitions in every prompt | 31,179 bytes | **2,996 bytes**, however many servers you add |
| Count errors in a 2,000-line log: bytes back to the model | 129,977 | **402** |
| Mail: count unread across 3 pages, pass a 150 KB image to another tool | 230,668 bytes back, 200,141 written out | **362 bytes** back |
| Startup: first `search` answered, tools cached | 1,697 ms (v0.1.1) | **320 ms** |

## Use it

Add one server to your coding agent. It finds the servers you already configured for any of these agents, so you don't move them.

**Claude Code**

```bash
claude mcp add codemode -- npx -y mcptocodemode serve
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.codemode]
command = "npx"
args = ["-y", "mcptocodemode", "serve"]
# Optional: also approve execute without asking. search and describe are read-only and need no approval.
# default_tools_approval_mode = "approve"
```

`execute` is marked as able to write, because the code can call any of your tools, so Codex asks before each run unless you set the line above.

**Grok** — `~/.grok/config.toml`, same table as Codex. Grok starts a server from a project's `.grok/config.toml` only in a trusted folder (`grok --trust`).

**Cursor** — `~/.cursor/mcp.json` or `.cursor/mcp.json`

```json
{ "mcpServers": { "codemode": { "command": "npx", "args": ["-y", "mcptocodemode", "serve"] } } }
```

**OpenCode** — `~/.config/opencode/opencode.json` or `opencode.json`

```json
{ "mcp": { "codemode": { "type": "local", "command": ["npx", "-y", "mcptocodemode", "serve"] } } }
```

OpenCode 2 has a code mode of its own and wraps MCP tools in it, so the model ends up calling `execute` through OpenCode's `execute`. It works, but it is slower than in agents without one.

**Pi**

```bash
pi mcp add codemode -- npx -y mcptocodemode serve
```

**Any other agent or provider.** MCPtoCodeMode is a stdio MCP server, so anything that speaks MCP can run it. The whole setup is one command:

```bash
npx -y mcptocodemode serve --config /path/to/servers.json
```

`servers.json` uses the standard `mcpServers` format above. Leave `--config` out to use the configs it discovers. If your agent has no MCP support, the [library](#library) gives you the same three tools to wire into any model API.

MCPtoCodeMode skips its own entry when it reads these configs. Remove your other servers from the agent if you want the model to see only the three tools.

Tested end to end, each agent answering a question through the three tools while MCPtoCodeMode read that agent's config: Claude Code 2.1, Codex 0.163, OpenCode 2.1, Pi 1.3, and Grok 1.0. Cursor's config format is covered by tests; its agent was not run.

## How it works

The model gets three tools:

- **`search`** finds methods by keyword. The top hits include their TypeScript signature.
- **`describe`** returns the full signature of a server (`"notes"`) or one method (`"notes.get"`).
- **`execute`** runs JavaScript. Each server is a global: `await notes.get({ id: "1" })`. Only the return value comes back, plus `console.log` output and a list of which methods ran.

Every server also has `resources.list`, `resources.read`, `resources.templates`, `prompts.list`, and `prompts.get`. Inside `execute`, `codemode.search` and `codemode.describe` work too. The full contract is [SPEC.md](SPEC.md).

## Configuration

With no flags, `serve` reads the MCP configs on your machine, in this order. A later server with the same name wins.

- `~/.codex/config.toml`, Claude Desktop, `~/.claude.json` (including the servers Claude Code stores for this project), `~/.cursor/mcp.json`, `~/.grok/config.toml`, `~/.config/opencode/opencode.json[c]`, `~/.config/mcp/mcp.json`, `~/.pi/agent/mcp.json`
- from the git root down to the current directory: `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.grok/config.toml`, `.codex/config.toml`, `opencode.json[c]`, `.pi/mcp.json`
- `./mcptocodemode.config.json`

It accepts standard `mcpServers` JSON, VS Code `servers` JSON, OpenCode `mcp` JSON or JSONC, and Codex or Grok `[mcp_servers.name]` TOML, over stdio, streamable HTTP, or SSE. `${VAR}` and `${VAR:-default}` expand from the environment.

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

The code runs in a [QuickJS](https://github.com/quickjs-ng/quickjs) WebAssembly isolate that lasts for the session: `let` and `const` end with each run, but `state` carries over, so one run can store threads and the next can filter them. `reset: true` starts an empty session, and so does a run that times out. Each run gets 30 seconds, 100 tool calls, and 100,000 characters of code; the session gets 64 MiB. Tool results over 200,000 characters come back truncated. Images, audio, and binary resources stay in the host as `{ $handle, type, mimeType }`, which the code can pass to another tool without the bytes ever entering the sandbox or the model's context.

The sandbox limits what the code can reach. It does not limit what a tool does: a tool that sends an email still sends it. Use `beforeCall` to block methods that need a human.

## Contributing

Setup and tests: [CONTRIBUTING.md](CONTRIBUTING.md). Questions: [SUPPORT.md](SUPPORT.md). Vulnerabilities: [SECURITY.md](SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This repository follows and defines the [minkaworks repository standard](STANDARD.md).

The idea comes from [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/). This project speaks plain MCP, so any MCP client can use it.
