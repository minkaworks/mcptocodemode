# minkaworks repository standard

Revision 2, 23 October 2026. This file is the canonical text. `mcptocodemode` is the first repository that follows it.

A repository follows the standard when every item in the checklist is true. Write each file for the project it belongs to. The checklist is the requirement. The sentences in the other files of this repository are one implementation of it.

An adopting repository links to a commit of this file and lists its exceptions. It does not paste these files in.

## Checklist

### Text

- Committed prose, commit subjects, issue templates, and code comments are English.
- The product name is the same in the README title, the package metadata, and the GitHub description.
- Examples use placeholders such as `${TOKEN}`. A measured artifact may be committed when it holds no secret and the report names the command that regenerates it.

### Identity

- The README opens with what the project does and the shortest command that shows it working.
- The README links to the specification (when the project has one), CI, the license, the changelog, contributing, security, support, and this standard.
- `LICENSE` is the full license text. The README, the package metadata, and GitHub agree on one SPDX identifier.
- Package metadata names the version, the license, the repository, and the issue tracker. `homepage` is a URL that resolves, or it is absent. The GitHub homepage field is a product URL that resolves, or it is empty.
- `packageManager` records the package manager and version that produced the lockfile, when the ecosystem has that field.
- The GitHub description is one sentence. Topics are words a person would search for this project. The default branch is `main`.

### Changes people can see

- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).
- The version in the changelog and the version in the package metadata are the same number.
- An entry describes what a user of the software, the library, or the repository can observe.
- `Unreleased` stays at the top. A published version is a git tag `vX.Y.Z` on the commit that declares that version. The tag is not moved.

### People

- `CONTRIBUTING.md` gives the setup, the typecheck command when the project has one, the test command, and the license the contribution is under.
- `CODE_OF_CONDUCT.md` states the expected behavior and a private contact that a maintainer reads. The contact is a verified address. When the project has no mailbox, the contact is a draft GitHub security advisory on this repository whose title starts with `Conduct:`, and the file says that.
- `SECURITY.md` tells a researcher how to report in private, which versions receive fixes, what is in scope, and what is out of scope.
- `SUPPORT.md` sends questions to the issue tracker and sends vulnerabilities to `SECURITY.md`.

### GitHub

- Issue forms exist for a defect and for a feature. Blank issues are off. A question form exists so a question still has a place to go.
- The form configuration links vulnerability reports to private advisories.
- The pull request template asks what changed, how it was verified, whether the public contract changed, and whether the diff contains a secret.
- Dependabot, or an equivalent a person reviews, opens updates for the package ecosystem and for GitHub Actions. The workflow does not merge those updates by itself.
- Private vulnerability reporting is enabled. Secret scanning and push protection are enabled on public repositories.

### CI

- A workflow runs on push to the default branch and on pull requests.
- The token is read-only unless a job has to write.
- The install uses the lockfile in frozen mode.
- The job runs the project's typecheck script, when it has one, and the test script.
- The matrix includes the oldest Node.js major that `engines` allows, and every newer major that Node.js still supports with security fixes, including Current. `CONTRIBUTING.md` names the majors in the matrix today.
- A major that is past security support stays in the matrix only while `engines` still allows it, and `CONTRIBUTING.md` says that it is past support.
- Logs do not print secrets. Jobs that need credentials or a live network service are separate from the required check.
- Actions are pinned to a major release tag. Dependabot bumps those tags. A commit SHA, with the version in a comment, is the pin for a workflow that reads secrets or publishes.
- A job builds the package and runs the same contents check the release runs, so a package that would publish broken fails on the pull request.

### Releases

- A release is a tag `vX.Y.Z` pushed on a commit of `main`. A workflow publishes it. Nobody publishes from a workstation.
- Before publishing, the workflow checks that the tag matches the package version, that `CHANGELOG.md` has a dated section and a link for that version, and that the package contains its entry points.
- The workflow publishes with the registry's trusted publishing (OIDC) and provenance, when the registry offers them. No long-lived registry token is stored as a secret.
- When the registry can stage a release for approval, the workflow stages it and a maintainer approves it with their second factor. The trusted publisher is not allowed to publish directly.
- The publishing job runs in a GitHub environment named for the registry. Only `v*` tags may deploy to it.
- The workflow creates the GitHub release. Its title is the version and its notes are that version's `CHANGELOG.md` section.
- Every tag has a GitHub release. A version that never reached the registry says so at the top of its notes.
- Rerunning the workflow for a tag that already published does not fail on the parts already done.
- A prerelease version publishes under a registry tag other than the default one, so installing without a version does not pick it up. Its GitHub release is marked as a prerelease.

### Tree

- `.editorconfig` sets UTF-8, LF, and a final newline.
- `.gitattributes` sets `text=auto` and `eol=lf`.
- `.gitignore` excludes dependencies, build output, logs, coverage, OS junk, editor state, and env files. It keeps the lockfile.
- A shared editor file that must be committed is a negated exception in `.gitignore`, with a reason in the commit.
- No token, env file, or private user config is committed.

### History

- `main` is append-only. A force-push is not part of the workflow.
- Commit subjects are English and imperative. The body says why when the diff does not.

## Files

| Path | Role |
| --- | --- |
| `README.md` | What it is, how to run it, where the other documents are |
| `LICENSE` | Full license text |
| `CHANGELOG.md` | Observable changes |
| `CONTRIBUTING.md` | Setup, tests, license |
| `CODE_OF_CONDUCT.md` | Behavior and a private contact |
| `SECURITY.md` | Private vulnerability reports |
| `SUPPORT.md` | Questions, separate from vulnerabilities |
| `STANDARD.md` | This text, in this repository only |
| `.editorconfig` | Editor defaults |
| `.gitattributes` | Line endings |
| `.gitignore` | Generated files and secrets |
| `.github/workflows/ci.yml` | Required check |
| `.github/workflows/release.yml` | Publish a tag and create its release |
| `.github/dependabot.yml` | Dependency updates |
| `.github/PULL_REQUEST_TEMPLATE.md` | What a change has to answer |
| `.github/ISSUE_TEMPLATE/` | Defect, feature, question |
| Lockfile | Frozen install |

## Outside this standard

A container, a citation file, a notice file, a code owner file, and an agent instruction file are added when that project needs them. They are not required here.

A project does not grow a feature so that a template has something to describe.

## Adoption

1. Read the checklist against the repository you have.
2. Write the files for that repository.
3. Confirm the GitHub community documents and the required CI check.
4. In that repository's `CONTRIBUTING.md`, link to a commit SHA of this file and list every exception in one paragraph.

## This repository

Exceptions: none.

Node.js majors in CI on revision 2: 20, 22, 24, and 26. The rule that produced that list is in the CI section. Node.js 20 stopped receiving security fixes on 30 April 2026 and remains only because `engines` says `>=20`.

The registry is npm. The environment is `npm`. The release helper is `scripts/release.mjs` (`notes` and `check`). Revision 2 added the Releases section, the package check in CI, and the SHA pin for a workflow that publishes.

The protocol contract is `SPEC.md`. This file does not change it.
