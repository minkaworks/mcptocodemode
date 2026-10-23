# MCPtoCodeMode

[Specification](SPEC.md) · [Benchmarks](REPORT.md) · [CI](https://github.com/minkaworks/mcptocodemode/actions/workflows/ci.yml) · [MIT License](LICENSE) · [Changelog](CHANGELOG.md)

One MCP server in front of all the MCP servers you already use. Your model sees three tools instead of hundreds, and it writes one short program instead of making dozens of tool calls.

```bash
npx -y mcptocodemode setup
```

That finds the coding agents on your machine (Claude Code, Codex, Cursor, Grok, OpenCode, Pi, Claude Desktop), lets you pick which ones get MCPtoCodeMode, and adds it after you confirm. It keeps using the MCP servers you already configured for them.

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

With Claude Sonnet 5.5 on real tasks, through OpenRouter:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers, three tasks × 3 runs | 9 / 9 | 9 / 9 |
| Input tokens for those 9 runs | 531,480 | **94,002** (5.7× fewer) |
| Cost for those 9 runs | $1.108 | **$0.222** (5× less) |
| Tokens to count errors in a 2,000-line log | 102,282 | **8,197** |
| Mail: page through threads, pass a 150 KB image to another tool (1 run) | failed, $0.756, 79 s | **correct**, $0.061, 10 s |
| Model turns, three tasks × 3 runs | 21 | 29 |

Same answers for a fifth of the cost. On the mail task, which moves a file between tools, plain MCP failed for both Sonnet and Haiku and MCPtoCodeMode got it right, one run each. It takes a few more turns: the model usually searches once before it writes the program.

Without a model in the loop:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Tool definitions in every prompt | 31,179 bytes | **2,996 bytes**, however many servers you add |
| Count errors in a 2,000-line log: bytes back to the model | 129,977 | **402** |
| Mail: count unread across 3 pages, pass a 150 KB image to another tool | 230,668 bytes back, 200,141 written out | **362 bytes** back |
| Startup: first `search` answered, tools cached | 1,697 ms (v0.1.1) | **320 ms** |

## Use it

```bash
npm install -g mcptocodemode
cm setup
```

`setup` lists the coding agents it finds with a checkbox each, asks whether to turn on [read-only mode](#read-only-mode) and the [registry](#find-and-install-servers), shows the exact command and every file it will touch, and changes them after you confirm. It uses each agent's own `mcp add` command where there is one, and otherwise edits the file after saving a `.mcptocodemode.bak` copy. Restart the agents afterwards. `cm setup --remove` takes it out again, and `--agents`, `--read-only`, `--registry`, `--yes`, and `--dry-run` skip the questions.

The global install gives you two names for the same command, `mcptocodemode` and the short `cm`. Without installing, run `npx -y mcptocodemode <command>`; `npx cm` would fetch an unrelated npm package.

MCPtoCodeMode reads the MCP configs your agents already have and skips its own entry, so your servers stay where they are. Remove them from an agent if you want its model to see only the three tools.

### Commands

| Command | What it does |
| --- | --- |
| `cm setup` | Add MCPtoCodeMode to the coding agents you pick. `--remove` takes it out. |
| `cm list` | Connect to every configured server and print what the model can call. |
| `cm find <words>` | Search the official MCP registry. |
| `cm index` | Download the registry once so `find` answers instantly. |
| `cm add <name>` | Save a registry server to your config, after showing what it runs. |
| `cm remove <server>` | Take a saved server out of your config, with its sign-in. |
| `cm login <server>` | Sign in to a remote server with OAuth in your browser. `logout` forgets it. |
| `cm serve` | Run the MCP server. This is what agents start. |
| `cm sdk --out api.d.ts` | Write the TypeScript the sandbox implements. |

### By hand

Each agent's own config works too. **Claude Code**

```bash
claude mcp add codemode -- npx -y mcptocodemode serve
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.codemode]
command = "npx"
args = ["-y", "mcptocodemode", "serve"]
```

`search` and `describe` are read-only, so Codex runs them without asking. `execute` can call any of your tools, so Codex asks before each run. Two ways to stop the prompts:

- Add `"--read-only"` to `args`. The code can then only call methods their servers mark read-only, and `execute` is announced as read-only, so Codex approves it. See [Read-only mode](#read-only-mode).
- Add `default_tools_approval_mode = "approve"` to approve everything, writes included.

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

Tested end to end, each agent answering a question through the three tools while MCPtoCodeMode read that agent's config: Claude Code 2.1, Codex 0.163, OpenCode 2.1, Pi 1.3, and Grok 1.0. Cursor's config format is covered by tests; its agent was not run.

## How it works

The model gets three tools:

- **`search`** finds methods by keyword. The top hits include their TypeScript signature.
- **`describe`** returns the full signature of a server (`"notes"`) or one method (`"notes.get"`).
- **`execute`** runs JavaScript. Each server is a global: `await notes.get({ id: "1" })`. Only the return value comes back, plus `console.log` output and a list of which methods ran. Variables end with each run; whatever the code puts on `state` is there for the next one.

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
| `--read-only` | Refuse methods their server does not mark read-only. Same as `CODEMODE_READ_ONLY=1`. |
| `--allow server.method` | With `--read-only`, permit one method, or a whole server with `server.*`. Repeatable. |
| `--registry` | `search` lists installable servers from the MCP registry and `codemode.install` installs one after you confirm. Same as `CODEMODE_REGISTRY=1`. |
| `--no-cache` | Don't read or write the tool cache. Same as `CODEMODE_CACHE=0`. |
| `CODEMODE_CACHE_DIR` | Where tool lists are cached. Default `~/.cache/mcptocodemode`. |

Servers connect in parallel. One that fails, or doesn't answer within 60 seconds, is skipped and the rest load. Tool lists are cached after each connect, so the next start answers at once and the servers connect in the background. A cache entry is keyed by a hash of the server config, and credentials are never written. `mcptocodemode list` refreshes the cache. `mcptocodemode sdk --out api.d.ts` writes the TypeScript the sandbox implements.

## Find and install servers

```bash
cm index
cm find supabase
cm add com.supabase/mcp
```

`find` searches the [official MCP registry](https://registry.modelcontextprotocol.io), about 48,000 servers. The registry's own search takes 20 to 40 seconds, so `index` downloads a local copy into the cache directory first, which took one to eight minutes in our runs depending on the registry's load. After that `find` answers in a second or two and fetches only what changed. `serve --registry` builds the index in the background.

Anyone can publish to the registry, so `find` tags what it can vouch for. `[vendor]` means the publisher is the brand you searched for, `com.supabase` for Supabase or `io.github.github` for GitHub, which the registry verifies against that domain or GitHub account. Those come first. `[owns repo]` means the publisher also owns the repository the entry points at, so it is not a republish of someone else's server. `add` shows the publisher, the exact command, and the variables it reads, asks you, and saves the server to `~/.config/mcptocodemode/servers.json`, which discovery reads. Variables are saved as `${NAME}`, never their values.

Start `serve` with `--registry` and the model can do the same in the conversation. `search` then also lists `available` servers, and the program can call `await codemode.install("io.github.acme/notes")`. Your agent shows you what would run and asks you to confirm; nothing runs until you say yes. The server connects without a restart and the program can use it on the next line. Searching sends the query to the registry only while the local index is being built, which is why `--registry` is off by default.

### Remote servers with sign-in

```bash
npx -y mcptocodemode login notion
```

Remote servers such as Notion, Linear, or Atlassian ask for an OAuth sign-in. `login` opens your browser, catches the redirect on `127.0.0.1:33418`, and keeps the result in `~/.config/mcptocodemode/oauth/`, readable only by you. `serve` then connects with it and refreshes it as needed. `serve` never opens a browser or registers a client on its own: a server that needs a sign-in fails with the exact `login` command, in `search` and in the error the code sees. `logout <server>` forgets it, and `remove <server>` takes a saved server out of your config along with its sign-in. A server whose config already sends an `Authorization` header does not use any of this.

`login` needs the server to support OAuth dynamic client registration, as Linear, Notion, Atlassian, Stripe, Supabase, Sentry, Vercel, Cloudflare, and Canva do. GitHub's remote server does not, so for GitHub use its local server with a `GITHUB_PERSONAL_ACCESS_TOKEN`.

## Library

```ts
import { catalogFromServers, CodeMode } from "mcptocodemode";

const catalog = catalogFromServers([
  { name: "notes", tools: [{ name: "get", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] },
]);
const mode = new CodeMode(catalog, async (call) => ({ id: call.input.id, title: "Buy milk" }));

await mode.execute(`return await notes.get({ id: "1" });`);
```

`beforeCall` can refuse a method before it runs, and `readOnlyPolicy` is a ready-made one. `createCodeModeServer(mode)` turns it into an MCP server, and `UpstreamPool` connects to real servers. `RegistryClient` searches the registry, `login` signs in to a remote server, and `runSetup` is the installer behind `cm setup`.

## Limits and safety

The code runs in a [QuickJS](https://github.com/quickjs-ng/quickjs) WebAssembly isolate that lasts for the session: `let` and `const` end with each run, but `state` carries over, so one run can store threads and the next can filter them. `reset: true` starts an empty session, and so does a run that times out. Each run gets 30 seconds, 100 tool calls, and 100,000 characters of code; the session gets 64 MiB. Tool results over 200,000 characters come back truncated. Images, audio, and binary resources stay in the host as `{ $handle, type, mimeType }`, which the code can pass to another tool without the bytes ever entering the sandbox or the model's context.

The sandbox limits what the code can reach. It does not limit what a tool does: a tool that sends an email still sends it. Use read-only mode, or `beforeCall` in the library, to block methods that need a human.

### Read-only mode

```bash
npx -y mcptocodemode serve --read-only --allow memory.create_entities
```

MCP servers mark each tool with hints such as `readOnlyHint` and `destructiveHint`. With `--read-only`, a call goes upstream only when its server marks the method read-only, or when `--allow` names it. Listing and reading resources and prompts always goes through. Anything else fails inside the program with a message that names the `--allow` flag, before it reaches the server. In return, `execute` is announced as read-only, so agents that approve read-only tools, like Codex, stop asking before each run.

Of the 55 tools in the seven reference servers, 36 are marked read-only, 12 write, and 7 are marked destructive. The hints come from each server, so read-only mode is as trustworthy as the servers you connect. In the library, `readOnlyPolicy(catalog, { allow })` is the same check as a `beforeCall`.

## Contributing

Setup and tests: [CONTRIBUTING.md](CONTRIBUTING.md). Questions: [SUPPORT.md](SUPPORT.md). Vulnerabilities: [SECURITY.md](SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This repository follows and defines the [minkaworks repository standard](STANDARD.md).

The idea comes from [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/). This project speaks plain MCP, so any MCP client can use it.
