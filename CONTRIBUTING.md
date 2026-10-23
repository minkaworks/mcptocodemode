# Contributing

This repository follows the [minkaworks repository standard](STANDARD.md), revision 2. Exceptions: none.

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

`pnpm measure` repeats the comparison in [REPORT.md](REPORT.md). It needs a network connection, `npx`, and `uvx`. `pnpm bench:model` runs the model section after `pnpm measure` has written its fixtures. It needs `OPENROUTER_API_KEY` in the environment or in `.env`, and costs about $1.40 with the default models. CI runs neither.

Node.js 20 stopped receiving security fixes on 30 April 2026. CI still runs it because `engines` allows it. Use 22, 24, or 26 for daily work.

## Changes

- Write committed prose and commit subjects in English. Use an imperative subject. Explain why in the body when the diff does not.
- Update [SPEC.md](SPEC.md) in the same change when `search`, `describe`, or `execute` changes.
- Add an `Unreleased` entry to [CHANGELOG.md](CHANGELOG.md) when a user of the server, the library, or the repository can observe the change.
- Keep secrets, `.env` files, and private MCP configs out of the diff. Examples use placeholders such as `${TOKEN}`.
- The server advertises three tools. A fourth tool is a change to `SPEC.md` and the pull request says why.

## Pull requests

Use the pull request template. CI runs `pnpm typecheck` and `pnpm test` on the latest patch of Node.js 20, 22, 24, and 26, and a package job builds `dist/` and runs `node scripts/release.mjs check`.

## Releases

1. In one commit on `main`, set `version` in `package.json` and move the `Unreleased` entries into a dated `## [X.Y.Z] - YYYY-MM-DD` section, with its compare link at the bottom of `CHANGELOG.md`.
2. `pnpm build && node scripts/release.mjs check` passes locally.
3. `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.

[`.github/workflows/release.yml`](.github/workflows/release.yml) checks the tag against the version and the changelog, publishes to npm with provenance through trusted publishing, and creates the GitHub release from that changelog section. Do not run `npm publish` by hand.

To try the pipeline without moving `latest`, set a prerelease version such as `0.3.0-rc.1` and push `v0.3.0-rc.1`. It publishes under the npm tag `next`, takes its notes from `Unreleased`, and its GitHub release is a prerelease.

npm has to trust the workflow once: on npmjs.com, the package settings name `minkaworks/mcptocodemode`, workflow `release.yml`, environment `npm` as the trusted publisher.

## Conduct and vulnerabilities

Behavior in issues and pull requests is [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). A vulnerability goes through [SECURITY.md](SECURITY.md), not through a pull request.
