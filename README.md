# MCPtoCodeMode

An MCP server that sits in front of your other MCP servers. The model gets three tools, `search`, `describe` and `execute`, and calls your servers from a short JavaScript program. Only the program's result goes back into the conversation.

```bash
npx -y mcptocodemode demo    # offline comparison, no keys or config
npx -y mcptocodemode setup   # add it to your coding agents
```

`setup` finds Claude Code, Codex, Cursor, Grok, OpenCode, Pi and Claude Desktop, and asks which of them to configure. It reuses the MCP servers each agent already has, lists every file it will change, and writes nothing until you confirm. Restart the agents afterwards.

`setup` does not remove the servers you already had, so until you take them out the agent sees their tools as well as the three new ones. [docs/agents.md](docs/agents.md#expose-only-three-tools) shows how to take them out without losing their config.

## When it helps

A program can page through results, aggregate records, or pass a file from one tool to another without any of it entering the conversation. For example, to total the paid orders in a folder of JSON files:

```js
const listing = await filesystem.list_directory({ path: "/data/orders" });
const names = listing.content.split("\n").map((line) => line.replace("[FILE] ", ""));
const orders = await Promise.all(
  names.map(async (name) => JSON.parse((await filesystem.read_text_file({ path: `/data/orders/${name}` })).content)),
);
const paid = orders.filter((order) => order.status === "paid");
return { paid: paid.length, total: paid.reduce((sum, order) => sum + order.total, 0) };
```

Called directly, every file would come back into the conversation for the model to add up. Here only `{ paid, total }` comes back.

For one call with a short answer, calling the tool directly is simpler.

## Benchmarks

Claude Sonnet 5.5 on three tasks, three runs each, against seven [reference servers](https://github.com/modelcontextprotocol/servers) that expose 55 tools:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers | 9 / 9 | 9 / 9 |
| Input tokens | 531,480 | 94,002 |
| Cost | $1.108 | $0.222 |
| Turns | 21 | 29 |
| Tool definitions in every prompt | 31,179 bytes | 2,996 bytes |

Both setups answered every task correctly. MCPtoCodeMode took more turns because the model usually ran `search` first. A fourth task paged through mail and passed a 150 KB image between tools. Through plain MCP, Sonnet didn't produce a correct answer ($0.756, 79 s). Through MCPtoCodeMode it did ($0.061, 10 s), because the image went from one tool to the next as a handle and never entered the conversation.

[REPORT.md](REPORT.md) has the method, raw data and limits: three small tasks, two models and one machine.

## How it works

- **`search`** finds methods by keyword and returns TypeScript signatures for the top results.
- **`describe`** returns the signatures of one server (`"notes"`) or one method (`"notes.get"`).
- **`execute`** runs JavaScript in which each server is a global, for example `await notes.get({ id: "1" })`. It returns the program's result, its `console.log` output and the list of methods it called. Anything the program puts on `state` is still there on the next run.

The program runs in a QuickJS sandbox with no network, filesystem or credentials, so it can only reach the world through your MCP servers. The tools themselves are not restricted: one that sends email still sends it. [`--read-only`](docs/configuration.md#read-only-mode) refuses any method its server does not mark as read-only. The full contract is in [SPEC.md](SPEC.md).

## Commands

`npm install -g mcptocodemode` installs the `cm` and `mcptocodemode` commands. Without installing, run `npx -y mcptocodemode <command>`. Note that `npx cm` runs a different package.

| Command | What it does |
| --- | --- |
| `cm setup` | Add MCPtoCodeMode to the agents you pick. `--remove` takes it out. |
| `cm demo [--json]` | Run the offline mail comparison. |
| `cm doctor` | Check configuration without starting servers. |
| `cm list` | Connect to every server and print the methods available. |
| `cm find <words>` · `cm index` | Search the official MCP registry, or download it for faster search. |
| `cm add <name>` · `cm remove <server>` | Add a registry server to your config, or remove one. |
| `cm login <server>` · `cm logout <server>` | Sign in to a remote server with OAuth, or sign out. |
| `cm serve` | Run the MCP server. Agents start this. |
| `cm sdk --out api.d.ts` | Write the TypeScript declarations for the sandbox. |

[docs/agents.md](docs/agents.md) has the manual config for each agent. [docs/configuration.md](docs/configuration.md) covers server discovery, options, the registry, OAuth, troubleshooting and limits.

## Library

```ts
import { catalogFromServers, CodeMode } from "mcptocodemode";

const catalog = catalogFromServers([
  { name: "notes", tools: [{ name: "get", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] },
]);
const mode = new CodeMode(catalog, async (call) => ({ id: call.input.id, title: "Buy milk" }));

await mode.execute(`return await notes.get({ id: "1" });`);
```

- `beforeCall` can refuse a call before it runs. `readOnlyPolicy(catalog)` returns a `beforeCall` that blocks writes.
- `createCodeModeServer(mode)` serves a `CodeMode` over MCP.
- `UpstreamPool` connects to real MCP servers.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests and releases, and [CHANGELOG.md](CHANGELOG.md) lists every change. For questions see [SUPPORT.md](SUPPORT.md), and report vulnerabilities through [SECURITY.md](SECURITY.md). MIT licensed.

The idea comes from [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/). This project uses plain MCP, so it works with any MCP client.
