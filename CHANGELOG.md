# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `mcptocodemode find <words>` searches the official MCP registry from a local index in the cache directory. The first run indexes it, about 48,000 servers in a few minutes; later runs fetch only what changed. A vendor's own server ranks first, by its verified namespace.
- `mcptocodemode add <name>` shows the publisher, the exact command, and the variables a registry server reads, asks for confirmation, and saves it to `~/.config/mcptocodemode/servers.json`. Discovery reads that file. Saved entries hold `${NAME}`, never values.
- `serve --registry` (or `CODEMODE_REGISTRY=1`): `search` adds `available` servers from the registry, and `codemode.install(name)` installs one after the person at the client confirms through MCP elicitation. It connects at once and is bound for the rest of the program. The run's clock stops while waiting for the answer. A client that cannot ask gets the `add` command instead.
- `UpstreamPool.add` connects a server while running. `RegistryClient`, `installServer`, and `confirmInstall` for library users.

### Fixed

- `mcptocodemode/package.json` can be imported or required, for tools that read the installed version.

## [0.3.0] - 2026-10-22

### Changed

- `execute` keeps one sandbox isolate for the session instead of a fresh one per call. `let` and `const` still end with each run. The `state` global, and anything else on `globalThis`, carries over, so one run can store threads and the next can filter them. A server named `state` becomes `state_`.
- When a run and all its calls succeed, `calls` has one entry per method with `count` and the summed `ms`. A failed run keeps one entry per call.
- The `execute` description asks for one program that looks methods up with `codemode.search` and `codemode.describe`, calls them, filters, and keeps on `state` what the next run needs. `search` no longer tells the model to `describe` before every `execute`. The three tool definitions are 2,996 bytes.
- `PROTOCOL_VERSION` is `0.2`.

### Added

- `serve --read-only` refuses calls to methods their server does not mark `readOnlyHint`, before they reach the server, and announces `execute` as read-only so agents like Codex run it without asking. `--allow server.method` and `--allow server.*` make exceptions. `CODEMODE_READ_ONLY=1` does the same as the flag. The library has `readOnlyPolicy`.
- Tool annotations from upstream servers are kept in the catalog and the tool cache.
- `execute` takes `reset: true` to start from an empty session. A run that times out, runs out of memory, or is interrupted also clears the session, and its error ends with `The session was cleared.`
- A second `execute` while one is running returns `Another execute is still running.` and leaves the session alone.
- Images, audio, and resource blobs from tools without `structuredContent` stay in the host as `{ $handle, type, mimeType }`. Passing that object in another call's arguments sends the base64 to that tool. The bytes never enter the sandbox, `logs`, `calls`, or the result. Handles last for the session, up to 8 MiB each and 32 MiB in all; past that the value is `omitted: true` as before.
- `CodeMode.close()`, `CodeMode.blobs`, `SandboxSession`, and `BlobStore` for library users. `UpstreamPool.call` and `valueFromToolResult` take the blob store.
- [REPORT.md](REPORT.md) has a Mail section from `scripts/measure-mail.mjs`: paginated search, large bodies, and an image passed between tools. `scripts/bench-model.mjs` has the same task as `BENCH_TASKS=mail`. With Claude Sonnet 5.5 and Haiku 5.5, plain MCP failed it and MCPtoCodeMode answered it, one run each.
- `scripts/bench-model.mjs` stops a run past `BENCH_MAX_RUN_COST` (default $1), and `BENCH_APPEND=1` adds to the results file instead of replacing it.

### Fixed

- An array of a union type renders as `(A | B)[]` instead of `A | B[]`.
- The agent's own entry for MCPtoCodeMode no longer shows up in `list` and `search` as a server that did not connect. A nested copy answers the handshake as `mcptocodemode`, the parent drops that entry, and the cache remembers it so the next start does not launch it.
- OpenCode's `{env:VAR}` placeholders expand.

### Added

- Discovery reads OpenCode (`~/.config/opencode/opencode.json[c]`, `opencode.json[c]`), Pi (`~/.pi/agent/mcp.json`, `.pi/mcp.json`, `~/.config/mcp/mcp.json`), and project `.codex/config.toml`. OpenCode's `mcp` map, `type: "local" | "remote"`, command arrays, and `environment` are accepted.
- The README has a setup for Claude Code, Codex, Grok, Cursor, OpenCode, Pi, and any other MCP client.
- A release workflow. Pushing a tag `vX.Y.Z` checks the version, the changelog, and the package contents, publishes to npm with provenance through trusted publishing, and creates the GitHub release from `CHANGELOG.md`. A prerelease tag such as `v0.3.0-rc.1` publishes under the npm tag `next` and takes its notes from `Unreleased`. The workflow stages the package on npm, and it goes live when a maintainer approves it.
- `scripts/release.mjs`, with `notes` to print a version's changelog section and `check` to verify a package before it publishes. CI runs `check` on every pull request.
- GitHub releases for 0.1.1, 0.2.0, and 0.2.1.
- Signatures in `describe`, `search`, and `mcptocodemode sdk` show what a method resolves to, from the tool's `outputSchema`, instead of `Promise<unknown>`. Protocol methods have their own return types. With the reference servers, 28 of 55 tools declare one.
- MCP tool annotations: `search` and `describe` are read-only and idempotent, `execute` may write. Codex approves the first two without asking.
- `scripts/bench-model.mjs` runs the same tasks through a model twice, with every tool exposed directly and through MCPtoCodeMode, and records turns, tokens, cost, and a per-turn trace. It uses OpenRouter.

### Changed

- The `execute` description tells the model to compute its answer in the code, that a method resolves to the value in its signature and not to the `{ ok, result }` envelope, and to sample a `Promise<unknown>` value before returning it.
- The tool cache format is 3. Entries written by 0.2.x are ignored once and rewritten with output schemas and annotations.
- Repository standard revision 2: a Releases section, the package check in CI, and SHA pins for a workflow that publishes.

## [0.2.1] - 2026-10-22

### Fixed

- The `mcptocodemode` command is kept when the package is published with npm 11, which drops a `bin` path written as `./dist/cli.js`.

### Changed

- Vitest 4.1.12 for development, which closes two advisories in `@vitest/mocker`. The published package does not include Vitest.

## [0.2.0] - 2026-10-22

### Added

- `serve` caches each server's tool list. On the next start a cached server is searchable and describable at once and connects in the background. `--lazy` waits for the first call instead, and `--no-cache` or `CODEMODE_CACHE=0` turns the cache off. `mcptocodemode list` refreshes it.
- The top three `search` hits carry their TypeScript signature, so `execute` can often follow without a `describe`.
- `UpstreamPool.start`, `fileCache`, and `defaultCacheDir` for library users. `createCodeModeServer` takes a `ready` promise.
- [REPORT.md](REPORT.md) measures startup the way an MCP client sees it.

### Changed

- `serve` answers the MCP handshake before the servers have connected. `search`, `describe`, and `execute` wait for the servers that have no cached tool list.
- The `execute` description tells the model that independent calls run concurrently with `Promise.all`.
- The README leads with the use case, the benchmarks, and the one-line setup.

## [0.1.1] - 2026-10-22

### Fixed

- `serve` no longer launches itself without end when a client config it discovers lists mcptocodemode. A nested copy exits and that entry is skipped.
- A run that ends while a tool call is still in flight, such as `notes.list(); return 1`, no longer aborts the whole process.
- `execute` accepts an already-invoked IIFE and a bare expression such as `(await notes.list()).length`.
- `mcptocodemode sdk` writes a declaration file that TypeScript parses. Protocol methods nest under `resources` and `prompts`.
- The server and client report the package version instead of a fixed `0.1.0`.

### Changed

- Upstream servers connect in parallel. A server that does not answer within 60 seconds is recorded as failed and the others load.

### Added

- Discovery reads the servers Claude Code stores for the current project in `~/.claude.json`, which is where `claude mcp add` puts them by default.
- [REPORT.md](REPORT.md) measures prompt growth server by server, a large result filtered in the sandbox, and a 25-call fan-out.
- `npm pack` and `npm publish` rebuild `dist/` from a clean directory.
- Repository standard in `STANDARD.md`, and the community files, editor defaults, issue forms, Dependabot config, and CI workflow that revision 1 requires.

## [0.1.0] - 2026-10-22

### Added

- An MCP server that advertises `search`, `describe`, and `execute`, in front of any number of upstream MCP servers.
- stdio, streamable HTTP, and SSE transports. A server that fails to connect is skipped. The others still load.
- `resources.list`, `resources.read`, `resources.templates`, `prompts.list`, and `prompts.get` on every connected namespace.
- Config readers for the native server list, `mcpServers`, VS Code, and Grok or Codex TOML, plus discovery of local MCP configs when `--config` is omitted.
- A QuickJS sandbox. Limits and the guest-visible surface are in [SPEC.md](SPEC.md).
- A reference config for the official servers in [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers).
- [REPORT.md](REPORT.md) and `pnpm measure`, comparing flat MCP, an inline SDK, and progressive Code Mode.

[Unreleased]: https://github.com/minkaworks/mcptocodemode/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/minkaworks/mcptocodemode/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/minkaworks/mcptocodemode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/minkaworks/mcptocodemode/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/minkaworks/mcptocodemode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/minkaworks/mcptocodemode/releases/tag/v0.1.0
