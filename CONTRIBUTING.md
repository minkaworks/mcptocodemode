# Contributing

This repository follows the [minkaworks repository standard](STANDARD.md), revision 1. Exceptions: none.

## License

A contribution is licensed under the MIT license in [LICENSE](LICENSE).

## Setup

Install [Node.js](https://nodejs.org/) 20 or newer and pnpm 10.28.0. Both are declared in `package.json` (`engines` and `packageManager`).

```bash
pnpm install
pnpm typecheck
pnpm test
```

`pnpm build` writes `dist/`. `node dist/cli.js serve --config mcptocodemode.config.example.json` starts the notes demo.

`pnpm measure` repeats the comparison in [REPORT.md](REPORT.md). It needs a network connection, `npx`, and `uvx`. CI does not run it.

Node.js 20 stopped receiving security fixes on 30 April 2026. CI still runs it because `engines` allows it. Use 22, 24, or 26 for daily work.

## Changes

- Write committed prose and commit subjects in English. Use an imperative subject. Explain why in the body when the diff does not.
- Update [SPEC.md](SPEC.md) in the same change when `search`, `describe`, or `execute` changes.
- Add an `Unreleased` entry to [CHANGELOG.md](CHANGELOG.md) when a user of the server, the library, or the repository can observe the change.
- Keep secrets, `.env` files, and private MCP configs out of the diff. Examples use placeholders such as `${TOKEN}`.
- The server advertises three tools. A fourth tool is a change to `SPEC.md` and the pull request says why.

## Pull requests

Use the pull request template. CI runs `pnpm typecheck` and `pnpm test` on the latest patch of Node.js 20, 22, 24, and 26.

## Conduct and vulnerabilities

Behavior in issues and pull requests is [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). A vulnerability goes through [SECURITY.md](SECURITY.md), not through a pull request.
