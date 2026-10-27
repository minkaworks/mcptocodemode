# MCPtoCodeMode

[Specification](SPEC.md) · [Benchmarks](REPORT.md) · [CI](https://github.com/minkaworks/mcptocodemode/actions/workflows/ci.yml) · [MIT License](LICENSE) · [Changelog](CHANGELOG.md)

One MCP server in front of all the MCP servers you already use. Your model sees three tools instead of hundreds, and writes one short program instead of making dozens of tool calls.

```bash
npx -y mcptocodemode demo    # local comparison, no keys or config
npx -y mcptocodemode setup   # add it to your coding agents
```

`setup` finds Claude Code, Codex, Cursor, Grok, OpenCode, Pi, and Claude Desktop, lets you pick which get MCPtoCodeMode, shows every file it will touch, and changes them after you confirm. It reuses the MCP servers those agents already have. Restart them afterwards.

## Why

Ask an agent with seven MCP servers to *"read these 25 order files and total the paid ones"*. That is 55 tool definitions in every prompt, 26 tool calls, and 26 turns, each re-reading every file before it. With MCPtoCodeMode the model writes this once, and only the answer comes back:

```js
const listing = await filesystem.list_directory({ path: "/data/orders" });
const names = listing.content.split("\n").map((line) => line.replace("[FILE] ", ""));
const orders = await Promise.all(
  names.map(async (name) => JSON.parse((await filesystem.read_text_file({ path: `/data/orders/${name}` })).content)),
);
const paid = orders.filter((order) => order.status === "paid");
return { paid: paid.length, total: paid.reduce((sum, order) => sum + order.total, 0) };
```

It helps most when an agent pages through results, aggregates records, or passes files between tools. For a single call with a short answer, calling directly is simpler.

## Benchmarks

Claude Sonnet 5.5 on real tasks, seven [reference servers](https://github.com/modelcontextprotocol/servers) with 55 tools:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers, 3 tasks × 3 runs | 9 / 9 | 9 / 9 |
| Input tokens | 531,480 | **94,002** (5.7× fewer) |
| Cost | $1.108 | **$0.222** (5× less) |
| Mail: page threads, pass a 150 KB image between tools | failed, $0.756, 79 s | **correct**, $0.061, 10 s |
| Tool definitions in every prompt | 31,179 bytes | **2,996 bytes** |

It takes a few more turns (29 vs 21), since the model usually searches before it writes the program. Method, raw data, and caveats are in [REPORT.md](REPORT.md).

## How it works

The model gets three tools:

- **`search`** finds methods by keyword, with TypeScript signatures for the top hits.
- **`describe`** returns the full signature of a server (`"notes"`) or a method (`"notes.get"`).
- **`execute`** runs JavaScript where each server is a global: `await notes.get({ id: "1" })`. Only the return value, `console.log` output, and the list of methods called come back. Whatever the code puts on `state` survives to the next run.

The code runs in a QuickJS sandbox with no network, filesystem, or credentials; its only way out is your MCP servers. The sandbox doesn't limit what a tool does, though: a tool that sends an email still sends it. Use [`--read-only`](docs/configuration.md#read-only-mode) to block writes. The full contract is [SPEC.md](SPEC.md).

## Commands

Install globally with `npm install -g mcptocodemode` to get `cm` (also `mcptocodemode`). Without installing, use `npx -y mcptocodemode <command>`; `npx cm` is an unrelated package.

| Command | What it does |
| --- | --- |
| `cm setup` | Add MCPtoCodeMode to the agents you pick. `--remove` takes it out. |
| `cm demo [--json]` | Run the local mailbox comparison. |
| `cm doctor` | Check configuration without starting servers. |
| `cm list` | Connect to every server and print what the model can call. |
| `cm find <words>` · `cm index` | Search the official MCP registry, or download it for instant search. |
| `cm add <name>` · `cm remove <server>` | Save a registry server to your config, or take one out. |
| `cm login <server>` · `cm logout <server>` | Sign in to a remote server with OAuth, or forget it. |
| `cm serve` | Run the MCP server. This is what agents start. |
| `cm sdk --out api.d.ts` | Write the TypeScript the sandbox implements. |

## Docs

- [Agents](docs/agents.md): manual config for each agent, and how to hide upstream tools so only three remain.
- [Configuration](docs/configuration.md): discovery, options, read-only mode, registry, OAuth, troubleshooting, limits.

## Library

```ts
import { catalogFromServers, CodeMode } from "mcptocodemode";

const catalog = catalogFromServers([
  { name: "notes", tools: [{ name: "get", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] },
]);
const mode = new CodeMode(catalog, async (call) => ({ id: call.input.id, title: "Buy milk" }));

await mode.execute(`return await notes.get({ id: "1" });`);
```

`beforeCall` can refuse a method before it runs (`readOnlyPolicy` is a ready-made one), `createCodeModeServer(mode)` makes it an MCP server, and `UpstreamPool` connects to real servers.

## Contributing

Setup and tests: [CONTRIBUTING.md](CONTRIBUTING.md). Questions: [SUPPORT.md](SUPPORT.md). Vulnerabilities: [SECURITY.md](SECURITY.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This repository follows the [minkaworks repository standard](STANDARD.md).

The idea comes from [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/). This project speaks plain MCP, so any MCP client can use it.
