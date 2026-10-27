# Configuration

## Discovery

With no flags, `serve` reads the MCP configs on your machine, in this order. A later server with the same name wins.

- `~/.codex/config.toml`, Claude Desktop, `~/.claude.json` (including the servers Claude Code stores for this project), `~/.cursor/mcp.json`, `~/.grok/config.toml`, `~/.config/opencode/opencode.json[c]`, `~/.config/mcp/mcp.json`, `~/.pi/agent/mcp.json`
- from the git root down to the current directory: `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.grok/config.toml`, `.codex/config.toml`, `opencode.json[c]`, `.pi/mcp.json`
- `./mcptocodemode.config.json`

It skips its own entry. It accepts standard `mcpServers` JSON, VS Code `servers` JSON, OpenCode `mcp` JSON or JSONC, and Codex or Grok `[mcp_servers.name]` TOML, over stdio, streamable HTTP, or SSE. `${VAR}` and `${VAR:-default}` expand from the environment.

## Options

| Option | Effect |
| --- | --- |
| `--config file` | Use only these files. Repeatable. `CODEMODE_CONFIG` sets one. |
| `--lazy` | Don't launch a cached server until code calls it. |
| `--read-only` | Refuse methods their server does not mark read-only. Same as `CODEMODE_READ_ONLY=1`. |
| `--allow server.method` | With `--read-only`, permit one method, or a whole server with `server.*`. Repeatable. |
| `--registry` | Let the model find and install servers from the MCP registry. Same as `CODEMODE_REGISTRY=1`. |
| `--no-cache` | Don't read or write the tool cache. Same as `CODEMODE_CACHE=0`. |
| `CODEMODE_CACHE_DIR` | Where tool lists are cached. Default `~/.cache/mcptocodemode`. |

Servers connect in parallel. One that fails, or doesn't answer within 60 seconds, is skipped and the rest load. Tool lists are cached per server config hash, without credentials, so the next start answers at once while servers reconnect in the background. `cm list` refreshes the cache.

## Read-only mode

```bash
npx -y mcptocodemode serve --read-only --allow memory.create_entities
```

A call goes upstream only when its server marks the method `readOnlyHint`, or when `--allow` names it. Resources and prompts always go through. Anything else fails inside the program, before it reaches the server, with a message naming the `--allow` flag. In return `execute` is announced as read-only, so agents like Codex stop asking before each run.

The hints come from each server, so read-only mode is as trustworthy as the servers you connect. Of the 55 tools in the seven reference servers, 36 are marked read-only, 12 write, and 7 are destructive.

## Registry

```bash
cm index
cm find supabase
cm add com.supabase/mcp
```

`find` searches the [official MCP registry](https://registry.modelcontextprotocol.io) (about 48,000 servers). The registry's own search takes 20 to 40 seconds, so `index` downloads a local copy first (one to eight minutes); after that `find` answers in a second or two and fetches only what changed.

Anyone can publish to the registry, so `find` tags what it can vouch for:

- `[vendor]`: the publisher is the brand you searched for, verified by the registry against its domain or GitHub account. Listed first.
- `[owns repo]`: the publisher also owns the repository the entry points at.

`add` shows the publisher, the command, and the variables it reads, asks you, and saves the server to `~/.config/mcptocodemode/servers.json`. Variables are saved as `${NAME}`, never their values.

With `serve --registry`, the model can do the same: `search` also lists `available` servers, and `await codemode.install("io.github.acme/notes")` installs one after your agent asks you to confirm. It connects without a restart. Queries go to the registry only while the local index is being built, which is why the flag is off by default.

## Remote servers with sign-in

```bash
cm login notion
```

`login` opens your browser for OAuth, catches the redirect on `127.0.0.1:33418`, and stores the result in `~/.config/mcptocodemode/oauth/`, readable only by you. `serve` uses and refreshes it but never opens a browser itself: a server that needs a sign-in fails with the exact `login` command. `logout <server>` forgets it; `remove <server>` also takes the server out of your config. A config that already sends an `Authorization` header skips all of this.

The server must support OAuth dynamic client registration, as Linear, Notion, Atlassian, Stripe, Supabase, Sentry, Vercel, Cloudflare, and Canva do. GitHub's remote server does not; use its local server with `GITHUB_PERSONAL_ACCESS_TOKEN`.

## Troubleshooting

```bash
cm doctor
cm doctor --config /absolute/path/servers.json --json
```

`doctor` checks the same configs `serve` would read, without starting anything. It reports unresolved variables, missing executables, bad working directories, and malformed URLs, prints only server names and config paths, and exits 1 on errors. It does not test sign-in, tool behavior, or remote availability. Unusual Node options or launch wrappers can hide its own entry from it. `cm list` tests real connections and exits 1 if any upstream fails.

- **A GUI agent can't find a command that works in your terminal**: its PATH and environment differ from your shell's.
- **Read-only mode refuses a method**: check the server's annotations, or use `--allow`.
- **OAuth fails**: see [Remote servers with sign-in](#remote-servers-with-sign-in).

## Limits

The code runs in a [QuickJS](https://github.com/quickjs-ng/quickjs) WebAssembly isolate that lasts for the session. `let` and `const` end with each run; `state` carries over. `reset: true` starts an empty session, and so does a run that times out.

| Limit | Value |
| --- | --- |
| Time per run | 30 s |
| Tool calls per run | 100 |
| Code per run | 100,000 characters |
| Session memory | 64 MiB |
| Tool result | truncated over 200,000 characters |

Images, audio, and binary resources stay in the host as `{ $handle, type, mimeType }`; code can pass them to another tool without the bytes entering the sandbox or the model's context.
