# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/minkaworks/mcptocodemode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/minkaworks/mcptocodemode/releases/tag/v0.1.0
