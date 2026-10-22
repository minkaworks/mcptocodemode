# Security

## Report a vulnerability

Open a [private advisory](https://github.com/minkaworks/mcptocodemode/security/advisories/new).

Do not file a public issue for a vulnerability, a leaked credential, or a way around the sandbox boundary. The report includes the version, a config with secrets removed, and the steps that show the problem.

There is no bounty. We answer the report, fix a supported version or say why we will not, and credit the reporter when they want credit.

## Supported versions

| Version | Fixes |
| --- | --- |
| 0.1.x | Yes |

## Scope

In scope:

- Guest code reaching the network, the filesystem, or process credentials other than by a tool call the host dispatched.
- A log, an error, or a tool result that reveals a credential the process was given.
- One connected server being treated as another server's namespace.

Out of scope:

- An upstream tool doing the thing its description says. A tool that sends a message sends it when the guest calls it. `beforeCall` is how a host refuses that call.
- Availability of a third-party MCP server.
- Whether a model writes a good program. [REPORT.md](REPORT.md) measures bytes and time, not model quality.

The guest runs in a fresh QuickJS context. The host binds `console`, `codemode.search`, `codemode.describe`, and the connected servers. It does not bind `fetch`, filesystem access, or `process`.
