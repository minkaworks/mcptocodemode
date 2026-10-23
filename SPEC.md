# MCPtoCodeMode 0.2

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
      "score": 12,
      "signature": "notes.get(input: {\n    id: string;\n  }): Promise<unknown>"
    }
  ]
}
```

Hits do not include JSON Schemas. The first three hits of a non-empty query carry `signature`, the TypeScript call signature `describe` would return without its doc comment, when it is at most 1,200 characters. A model can often go from `search` to `execute` without a `describe` in between. An empty query returns no signatures. `servers` is the full list of configured namespaces, including a server that failed to connect. A failed server has `toolCount: 0` and an `error` string. That string must not contain credentials.

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

The result is TypeScript for that namespace or method. A method's return type is the tool's `outputSchema` when the server declares one, since the sandbox receives `structuredContent` for such a tool. Without one it is `unknown`. Protocol methods have fixed return types. A namespace listing may omit methods once it passes a size budget. The omitted methods remain available through `describe("server.method")`.

Describing a server that did not connect returns the connect error and no methods.

### execute

```json
{
  "type": "object",
  "required": ["code"],
  "properties": {
    "code": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1 },
    "reset": { "type": "boolean" }
  }
}
```

`code` is one program that looks up what it needs, calls it, reduces the results, and returns the answer. It is either an async function body or a function expression. Both of these are valid:

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

`reset: true` replaces the session's isolate before the code runs. See [Session](#session).

The result is JSON. When the run succeeds and every call in it succeeded, `calls` has one entry per method, with the number of calls and their summed time:

```json
{
  "ok": true,
  "result": ["Buy milk", "Ship codemode"],
  "logs": [],
  "calls": [
    { "server": "notes", "method": "list", "count": 1, "ms": 4 },
    { "server": "notes", "method": "get", "count": 2, "ms": 9 }
  ]
}
```

When the run fails, or any call in it failed, `calls` has one entry per call, in completion order:

```json
{
  "ok": false,
  "error": "No note 9",
  "logs": [],
  "calls": [
    { "server": "notes", "method": "list", "ok": true, "ms": 4 },
    { "server": "notes", "method": "get", "ok": false, "ms": 3 }
  ]
}
```

Neither form records arguments or payloads. Those stay in the sandbox unless the code returns them.

On failure, `ok` is false and `error` is a string. A failed call fails the run unless the code catches it. A second `execute` that arrives while one is running returns `{ "ok": false, "error": "Another execute is still running." }` and does not touch the session.

## Sandbox

Inside the isolate:

- One global per connected upstream server. The global's name is the server name sanitized to an identifier (`google-calendar` becomes `google_calendar`). A server that did not connect has no global.
- Each upstream tool is a method. The method name is the tool name sanitized the same way. Hyphens become underscores. Collisions get a numeric suffix.
- `resources` and `prompts` are reserved on every server. A tool with one of those names is suffixed (`resources_2`).
- A method takes one object argument and returns a Promise. No required fields means the argument may be omitted.
- `codemode.search(query, options?)` and `codemode.describe(target)` do the same work as the outer tools, and their results stay in the sandbox.
- `state` is an object the host creates. It survives between runs of the same session.
- `console.log`, `console.info`, `console.warn`, and `console.error` append to `logs`.

The isolate has no network, filesystem, process, or environment. It cannot see credentials. Upstream calls go back to the host, and the host is what talks to MCP.

A run stops when the code finishes, the deadline passes, the tool-call budget is spent, or the memory limit is hit. The default budgets in this implementation are 30 seconds, 100 calls, and 100,000 characters of code per run, and 64 MiB of memory for the session. The call budget and the logs start over with each run. Results larger than 200,000 characters of JSON are replaced with a truncation marker before they re-enter the sandbox.

### Session

A session is one isolate kept across `execute` calls. In this implementation it is one `CodeMode`, which for `serve` means the process and its one client. Nothing is written to disk.

Each run's code is wrapped in its own async function, so `let`, `const`, and function declarations end with the run. The `state` global survives, and so does any other property the code puts on `globalThis`:

```js
state.threads = await gmail.search_threads({ query: "newer_than:7d" });
return state.threads.length;
```

```js
return state.threads.filter((thread) => thread.unread).length;
```

The second run sees the threads the first one stored.

`reset: true` replaces the isolate before the code runs. A run that times out, hits the memory limit, or is interrupted also replaces it, and its error ends with `The session was cleared.` The next run starts with an empty `state`.

A server that connects after a run is bound before the next one. Binding adds missing servers and methods. It does not replace a global the code already defined under that name. A server whose name sanitizes to `state` is suffixed (`state_`).

### Handles

An image or audio block, or a resource blob, that has no `structuredContent` around it stays in the host. The code receives a handle:

```json
{ "$handle": "blob_5f1c0a9e2b7d4c13", "type": "image", "mimeType": "image/png" }
```

A resource blob from `resources.read` comes back as `{ "uri": "...", "mimeType": "...", "blob": { "$handle": "...", "type": "blob", "mimeType": "..." } }`.

When the code passes an object whose only keys are `$handle` and, optionally, `type` and `mimeType` anywhere in a method's argument, the host replaces it with the base64 bytes before the call goes upstream:

```js
const image = await mail.get_attachment({ id: "att-7" });
return await search.index_attachment({ file: image });
```

The bytes never enter the isolate, `logs`, `calls`, or the result. A handle that comes back in the result is just the handle. An unknown handle fails that call.

Handles belong to the session and end with it. In this implementation one blob may hold up to 8 MiB and the session up to 32 MiB. Past either limit the value is `{ "type": "image", "mimeType": "image/png", "omitted": true }`, with no handle.

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

Resource text is returned. Resource blobs, images, and audio are not copied into the sandbox. The code receives a handle, or an object with `omitted: true` when there is no room. See [Handles](#handles).

## Host

The host holds one MCP client per connected server. A tool call from the sandbox is `tools/call` on that server. A protocol call is the matching resources or prompts request. The host may reject a call before it is sent. Rejection fails that call with the host's message.

A server is configured as a stdio command or a URL. The URL transport is streamable HTTP unless the config says `sse`. Legacy SSE remains part of the protocol, so a conforming host accepts it.

The host reads servers from the caller's config. It accepts `{ servers: [...] }`, standard `{ mcpServers: { ... } }`, a `servers` object map, and `[mcp_servers.name]` TOML. `enabled: false` skips a server. Servers from later files replace earlier servers with the same name.

Connecting is per server. One failed handshake does not drop the others. The failure is visible from `search` and from `describe`. A host may give up on a server that does not answer in time. That counts as a failed handshake.

A host may keep each server's tool list from an earlier connect and serve the catalog from it. Such a server can be searched, described, and bound in the sandbox before it connects. It connects in the background or on its first call. When it connects, its live tool list replaces the kept one for later runs, and a call to a tool it no longer has fails with the server's own answer. A server that fails on that connect is reported like a failed handshake. A kept list is keyed by everything in the server's config, credentials included, and the credentials themselves are not stored.

The host answers the MCP handshake before every server has connected. `search`, `describe`, and `execute` wait until each server without a kept list has connected or failed.

Restart the server to pick up tools, resources, or prompts that appear later on a server that is already connected.

## Names

| Field | Meaning |
| --- | --- |
| `servers[].name` | The name in the config file. |
| `servers[].ident` | The global the code uses. |
| `hits[].tool` | The tool name the upstream server expects. For a protocol method, this is the method path. |
| `hits[].method` | The method the code calls. |

Some gateways flatten tools as `server__tool`. Splitting on the first `__` recovers the namespace. This server does that only when a caller asks it to import a flat list. Live connections use each server's own tool names and the config name as the namespace.
