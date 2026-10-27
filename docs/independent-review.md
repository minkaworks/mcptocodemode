# Independent review record

Scope: all local changes since `d9be84fe7a0ca9c9891521183bd0153eea851ba5`, including new source, scripts, tests and documentation. The pre-existing untracked `package-lock.json` is excluded and preserved. No commits, push, release, outreach or live user-config changes are part of this work.

The user requested at least three second opinions. Three rounds each use a new pair of independent, read-only reviewers: one for documented repository standards and one for the requested behavior and launch claims. Reviewers receive the fixed base, current work scope and requirements; they report findings without editing. The parent verifies and fixes issues between rounds. Standards and behavior findings remain separate.

## Round 1

### Standards

No hard documented-standard violations, actionable heuristic smells or concrete regressions. Reviewer inspected the complete diff and additions against STANDARD.md, CONTRIBUTING.md, SPEC.md and SECURITY.md. Typecheck and eight focused demo/doctor tests passed. No package install or hosted CI was repeated by this reviewer.

### Spec

Two P2 findings:

- Discovered malformed configs lost the offending pathname. `doctor` reported only a generic warning, and the malformed file was missing from the files array. Fixed by keeping warning source paths separate from sensitive parser excerpts and displaying both healthy and failing config paths. Regression verifies an invalid discovered TOML file is identified without exposing its contents.
- When PATH was absent, `doctor` searched only cwd and rejected a command that `list` could launch through the POSIX spawn default. Fixed by distinguishing absent PATH (`/usr/bin:/bin`) from an explicitly empty PATH (cwd). Regression covers both, and a separate isolated CLI reproduction verified that doctor and list agree without PATH.

No scope creep identified. The reviewer reproduced the diagnostic failures and independently confirmed the demo's equal answers and six calls.

## Round 2

### Standards

No hard standard violations or concrete regressions. Both round-one fixes checked. One nonblocking judgement call: the executable-file check was duplicated between doctor and agent detection. The parent extracted a shared `isExecutable` helper. The reviewer passed typecheck and ten focused tests from a temporary copy without modifying the repository.

### Spec

One P3 finding: a source-style `node /path/to/this/package/dist/cli.js serve` entry was counted as an upstream even though the real connection recognizes and removes itself. Fixed by checking this package's real entrypoint path without executing it. Tests distinguish its own `serve` entry, its legitimate `demo-upstream`, and an unrelated file named `cli.js`; the packed-package smoke includes the installed entrypoint case.

No other missing claims, wrong implementations or scope creep identified. The reviewer used isolated reproductions and inspected both earlier fixes and the entire changed scope.

## Round 3

### Standards

No hard standard breaches, actionable judgement smells or concrete regressions. Reviewer independently checked the full scope, all earlier fixes and the shared executable helper, then passed 24 tests across doctor, demo, agents and config on Node 26.12.1 in a temporary copy. Package installation and hosted CI were not repeated by this reviewer.

### Spec

One P3 finding: own-server detection missed common Node options before the entrypoint. `node --enable-source-maps /path/to/cli.js serve` was still counted as an upstream, while a live connection correctly removed it. The parent corrected conservative Node-option parsing and added regressions for flags, preloads, `--`, inline/unrelated programs, and the installed-package entrypoint. Unknown Node options and arbitrary launch wrappers still require a live connection check; README makes that limit explicit.

No other missing/partial claims, scope creep or incorrect implementations were found. The reviewer independently ran help/version/demo/doctor checks with writes, network and child-process execution blocked, checked redaction and unchanged fixtures, and reconfirmed the comparison's equal answers and six calls.

This final small correction is covered by automated regressions and package checks, rather than a fourth independent review. Three complete rounds and six reviewers were used.

## Final validation

88 tests pass on both Node 22.22.2 and Node 26.12.1 after the last Node-option correction. Typecheck, build, package contents/release checks and diff whitespace checks pass. The actual tarball was installed again into temporary directories on both Node versions; demo, doctor, own-entry exclusion with and without Node flags, CLI help/version, failed-server exit status and all three MCP tools through stdio passed.

Standards totals: zero hard violations, one nonblocking duplication consolidated. Spec totals: two P2 findings and two P3 findings, all corrected. These are the findings of the reviews, not a guarantee that no other defects exist. Hosted CI, the full live-agent matrix, Windows acceptance and a new public npm release have not run. The previous conclusion stands: prepare the release and seek user feedback before adding features.
