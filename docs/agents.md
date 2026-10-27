# Agents

`cm setup` configures these for you. This page is for doing it by hand, and for
hiding the upstream tools so the agent sees only Code Mode's three.

## By hand

**Claude Code**

```bash
claude mcp add codemode -- npx -y mcptocodemode serve
```

**Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.codemode]
command = "npx"
args = ["-y", "mcptocodemode", "serve"]
```

`search` and `describe` are read-only, so Codex runs them without asking. `execute` can call any of your tools, so Codex asks before each run. Two ways to stop the prompts:

- Add `"--read-only"` to `args`. `execute` is then announced as read-only and Codex approves it. See [read-only mode](configuration.md#read-only-mode).
- Add `default_tools_approval_mode = "approve"` to approve everything, writes included.

**Grok**: `~/.grok/config.toml`, same table as Codex. Grok starts a server from a project's `.grok/config.toml` only in a trusted folder (`grok --trust`).

**Cursor**: `~/.cursor/mcp.json` or `.cursor/mcp.json`

```json
{ "mcpServers": { "codemode": { "command": "npx", "args": ["-y", "mcptocodemode", "serve"] } } }
```

**OpenCode**: `~/.config/opencode/opencode.json` or `opencode.json`

```json
{ "mcp": { "codemode": { "type": "local", "command": ["npx", "-y", "mcptocodemode", "serve"] } } }
```

OpenCode 2 has a code mode of its own and wraps MCP tools in it, so the model ends up calling `execute` through OpenCode's `execute`. It works, but it is slower than in agents without one.

**Pi**

```bash
pi mcp add codemode -- npx -y mcptocodemode serve
```

**Anything else that speaks MCP** can run it as a stdio server:

```bash
npx -y mcptocodemode serve --config /path/to/servers.json
```

Leave `--config` out to use the configs it [discovers](configuration.md#discovery). Without MCP support, use the [library](../README.md#library).

Tested end to end, each agent answering a question through the three tools while MCPtoCodeMode read that agent's config: Claude Code 2.1, Codex 0.163, OpenCode 2.1, Pi 1.3, and Grok 1.0. Cursor's config format is covered by tests; its agent was not run.

## Expose only three tools

`setup` adds Code Mode next to your servers; the agent still sees their direct tools. To leave only `search`, `describe`, and `execute`:

1. Copy your upstream definitions into a separate file, such as `/absolute/path/servers.json`. Keep credentials as `${TOKEN}`.

   ```json
   { "mcpServers": { "notes": { "command": "your-notes-server", "args": [] } } }
   ```

2. Check it with `cm doctor --config /absolute/path/servers.json`, then connect with `cm list --config /absolute/path/servers.json`. Only `list` starts the servers.
3. Point the agent's `codemode` entry at the file:

   ```json
   {
     "mcpServers": {
       "codemode": {
         "command": "npx",
         "args": ["-y", "mcptocodemode", "serve", "--config", "/absolute/path/servers.json"]
       }
     }
   }
   ```

4. Back up the agent's config, remove the upstream entries from it, and restart the agent. Its built-in tools stay.

A good first prompt: "Use Code Mode search to show which upstream servers are available and describe one read-only method. Do not execute it." Then try a small read-only task before anything that writes.
