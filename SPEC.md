# MCPtoCodeMode 0.1

MCPtoCodeMode is a way to use many MCP servers through three tools. The model writes JavaScript. The code runs in a sandbox whose only way out is the upstream MCP servers.

This document is the contract. An implementation can sit in front of any number of MCP servers. Any MCP client can use it. Servers are not special-cased. The same rules apply to every server that speaks MCP.

## Why

An MCP client that forwards every upstream tool spends context on tools the model will not call. A handful of servers is already enough to put a couple of hundred tools in the prompt. The model also has to copy each tool result back into the next call.

Code Mode, as described by Cloudflare, turns those tools into an API and asks the model to write code against it. This spec keeps that idea and makes two changes:

- The wire interface is MCP, so the client does not need a particular host runtime.
- Discovery stays out of the prompt. The model asks for the tools it needs.

## Tools

A conforming server advertises exactly these three tools. Their names are `search`, `describe`, and `execute`.

### search

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": { "type": "string" },
    "server": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 25 }
  }
}
```

`query` is a few words. `server` limits the search to one namespace. `limit` defaults to 8.

The result is JSON:

```json
{
  "servers": [{ "name": "notes", "ident": "notes", "toolCount": 2 }],
  "hits": [
    {
      "server": "notes",
      "method": "get",
      "tool": "get",
      "description": "Read one note by id.",
      "required": ["id"],
      "score": 12
    }
  ]
}
```

Hits do not include JSON Schemas. `servers` is the full list of configured namespaces, including a server that failed to connect. A failed server has `toolCount: 0` and an `error` string. That string must not contain credentials.

`toolCount` counts upstream tools. It does not count the protocol methods below. An empty query still returns `servers`, plus a sample of tools. The sample omits protocol methods. A query that names resources or prompts can return those methods.

### describe

```json
{
  "type": "object",
  "required": ["target"],
  "properties": { "target": { "type": "string" } }
}
```

`target` is a server ident (`notes`) or `server.method` (`notes.get`, `notes.resources.read`). The first `.` separates the server from the method. The method may itself contain dots.

The result is TypeScript for that namespace or method. A namespace listing may omit methods once it passes a size budget. The omitted methods remain available through `describe("server.method")`.

Describing a server that did not connect returns the connect error and no methods.

### execute

```json
{
  "type": "object",
  "required": ["code"],
  "properties": {
    "code": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1 }
  }
}
```

`code` is either an async function body or a function expression. Both of these are valid:

```js
const rows = await notes.list();
return rows.map((row) => row.id);
```

```js
async () => {
  const memo = await notes.resources.read({ uri: "note://1" });
  return memo.text;
}
```

The result is JSON:

```json
{
  "ok": true,
  "result": ["1", "2"],
  "logs": [],
  "calls": [{ "server": "notes", "method": "list", "ok": true, "ms": 40 }]
}
```

`calls` records the server, the method, whether it succeeded, and how long it took. It does not record arguments or payloads. Those stay in the sandbox unless the code returns them.

On failure, `ok` is false and `error` is a string. A failed call fails the run unless the code catches it.

## Sandbox

Each `execute` gets a fresh JavaScript isolate.

Inside it:

- One global per connected upstream server. The global's name is the server name sanitized to an identifier (`google-calendar` becomes `google_calendar`). A server that did not connect has no global.
- Each upstream tool is a method. The method name is the tool name sanitized the same way. Hyphens become underscores. Collisions get a numeric suffix.
- `resources` and `prompts` are reserved on every server. A tool with one of those names is suffixed (`resources_2`).
- A method takes one object argument and returns a Promise. No required fields means the argument may be omitted.
- `codemode.search(query, options?)` and `codemode.describe(target)` do the same work as the outer tools, and their results stay in the sandbox.
- `console.log`, `console.info`, `console.warn`, and `console.error` append to `logs`.

The isolate has no network, filesystem, process, or environment. It cannot see credentials. Upstream calls go back to the host, and the host is what talks to MCP.

A run stops when the code finishes, the deadline passes, the tool-call budget is spent, or the memory limit is hit. The default budgets in this implementation are 30 seconds, 100 calls, 64 MiB, and 100,000 characters of code. Results larger than 200,000 characters of JSON are replaced with a truncation marker before they re-enter the sandbox.

## Protocol methods

Every connected server exposes the same MCP features, not only tools:

| Code | MCP method |
| --- | --- |
| `server.resources.list()` | `resources/list` |
| `server.resources.read({ uri })` | `resources/read` |
| `server.resources.templates()` | `resources/templates/list` |
| `server.prompts.list()` | `prompts/list` |
| `server.prompts.get({ name, arguments? })` | `prompts/get` |

`arguments` values are strings, matching the MCP prompt schema. The host does not call these during connect. A server that does not implement one returns its own error when the code calls it.

Resource text is returned. Resource blobs, images, and audio are not copied into the sandbox. The code receives an object with `omitted: true` instead.

## Host

The host holds one MCP client per connected server. A tool call from the sandbox is `tools/call` on that server. A protocol call is the matching resources or prompts request. The host may reject a call before it is sent. Rejection fails that call with the host's message.

A server is configured as a stdio command or a URL. The URL transport is streamable HTTP unless the config says `sse`. Legacy SSE remains part of the protocol, so a conforming host accepts it.

The host reads servers from the caller's config. It accepts `{ servers: [...] }`, standard `{ mcpServers: { ... } }`, a `servers` object map, and `[mcp_servers.name]` TOML. `enabled: false` skips a server. Servers from later files replace earlier servers with the same name.

Connecting is per server. One failed handshake does not drop the others. The failure is visible from `search` and from `describe`.

Restart the server to pick up tools, resources, or prompts added after connect. The catalog is fixed at process start.

## Names

| Field | Meaning |
| --- | --- |
| `servers[].name` | The name in the config file. |
| `servers[].ident` | The global the code uses. |
| `hits[].tool` | The tool name the upstream server expects. For a protocol method, this is the method path. |
| `hits[].method` | The method the code calls. |

Some gateways flatten tools as `server__tool`. Splitting on the first `__` recovers the namespace. This server does that only when a caller asks it to import a flat list. Live connections use each server's own tool names and the config name as the namespace.
