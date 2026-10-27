# Launch readiness

Pre-release assessment recorded on 26 October 2026, based on 0.4.2, for the changes prepared as 0.5.0. At the time of this assessment the changes were unreleased, npm `latest` was 0.4.2, and no push, tag, publication or outreach had occurred. The checks below record that assessment; consult the GitHub release and npm registry for current publication status.

## Decision

Stop adding features for this launch. After publishing and verifying this change, the next useful work is distribution and feedback from people trying it with their own MCP servers. The first-use path now has a credential-free demo, a configuration check, a documented way to expose only the three Code Mode tools, and tests of the actual installed package.

## What can be demonstrated

After release, the shortest demonstration is `npx -y mcptocodemode demo`. Before release, use `pnpm install --frozen-lockfile && pnpm demo` in a checkout. The demo runs real MCP calls against an in-process synthetic mailbox, counts unread threads across three pages, and passes a 150,000-byte synthetic attachment to another tool.

The verified answer is 10 unread threads, target `t21`, and 150,000 indexed bytes. Both paths perform six upstream tool calls. The observed plain result content totals 230,668 UTF-8 JSON bytes; the full Code Mode execute envelope is about 362 bytes (timing fields can change its size). The attachment stays in the host, represented by a handle in the sandbox.

The measurement excludes discovery, tool definitions, input bytes, and any model execution. It does not establish model accuracy, latency improvement, token savings, billing savings, or behavior on real mail providers. The synthetic attachment has a PNG signature; no image decoding is tested. Historical model measurements and their caveats remain in [REPORT.md](../REPORT.md).

The target user already has several MCP tools and performs paging, aggregation, or tool-to-tool file transfer. For one tool with a small answer, direct MCP may be simpler. The benefit depends on returning a compact answer rather than forwarding every upstream result.

## Validation recorded

| Gate | Local evidence |
| --- | --- |
| Unit/integration tests | 88 passed on Node 26.12.1 and Node 22.22.2 after three independent-review rounds |
| Typecheck and build | Passed |
| Frozen dependency install | Passed with pnpm 10.28.0 |
| Package contents/release check | Passed; this checks the existing version metadata, not a published release |
| Fresh tarball install | Passed in temporary directories on Node 22 and 26 |
| Installed CLI | Demo text/JSON, doctor success/failure, help/version, and invalid argument handling |
| Installed MCP server | Real stdio handshake and calls to search, describe, and execute |
| Failed upstream | `list` exits 1 and closes its connections |
| Diagnostic privacy | Tests cover omitted args, URLs, headers, env values and parser excerpts, and unchanged config files |
| CI coverage configured | Unit tests and package smoke on Node 20, 22, 24 and 26; the updated hosted workflow has not run yet |

The full real-agent compatibility matrix was not repeated in this change. The existing README identifies previously tested agent versions and separates Cursor's config tests from live agent validation. Windows, Linux and remote OAuth acceptance have not been newly established by the local macOS tests.

Three rounds with six independent reviewers found two P2 and two P3 diagnostic issues, all corrected with regression tests, plus one duplicated check that was consolidated. The complete review record, including which checks each reviewer performed and the final small correction after round three, is in [independent-review.md](independent-review.md).

## Publication gate

Follow [CONTRIBUTING.md](../CONTRIBUTING.md): choose the next version, date its changelog section, and remove the README's Unreleased banner only for that release. The new commands are absent from the currently published 0.4.2 package. Push the versioned source and tag through the existing trusted-publishing workflow, let the hosted checks run, and approve the staged npm release as required by that workflow.

Then verify the published version with `npm view mcptocodemode version` and run `npx -y mcptocodemode@<version> demo --json` in an empty directory. Check `--version` and a sanitized real upstream config as a separate acceptance step. A local tarball pass is not proof that the npm release is live.

## Distribution experiment

Use one concrete claim: the model can return a small computed answer while paginated results and file bytes stay out of its context. Link to the runnable demo, the exact source, and the benchmark limitations.

Start with a small audience of developers who already use MCP. Ask whether they completed the demo, exposed only the three tools, and completed one task on their existing servers. Record the agent and MCP-server versions, installation failures, task correctness, and whether they used it again. Stars are a distribution signal; successful first use and repeat use decide the next engineering work.

Open implementation work only for a reproducible onboarding failure, a failed real task, or a repeated request from actual users. Additional integrations, a new UI, broader OAuth support, and new benchmark models are not prerequisites for this launch. No posts, registrations, or messages have been sent.
