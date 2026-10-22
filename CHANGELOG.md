# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/minkaworks/mcptocodemode/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/minkaworks/mcptocodemode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/minkaworks/mcptocodemode/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/minkaworks/mcptocodemode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/minkaworks/mcptocodemode/releases/tag/v0.1.0
