import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExecutable, onPath } from "./agents.js";
import { mergeServers, parseConfig, type ServerSpec } from "./config.js";
import { discoverConfig, type DiscoverOptions } from "./discover.js";

export type DoctorCheck = { status: "ok" | "error"; target: string; message: string };
export type DoctorReport = { ok: boolean; files: string[]; servers: number; checks: DoctorCheck[] };

/** Inspect configuration only. Never launches commands, contacts URLs, or writes files. */
export async function diagnose(options: DiscoverOptions & { configs?: string[] } = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const files: string[] = [];
  const checks: DoctorCheck[] = [];
  let servers: ServerSpec[] = [];
  if (options.configs?.length) {
    for (const file of options.configs) {
      files.push(file);
      try {
        const parsed = parseConfig(await readFile(path.resolve(cwd, file), "utf8"), file, env);
        // Parser messages can contain excerpts of credentials. Do not forward them.
        if (parsed.issues.length) checks.push({ status: "error", target: file, message: `Invalid configuration (${parsed.issues.length} issue(s)). Inspect this file locally; parser excerpts are withheld.` });
        servers = mergeServers(servers, parsed.servers);
      } catch {
        checks.push({ status: "error", target: file, message: "Cannot read this configuration file. Check the path and permissions." });
      }
    }
  } else {
    const discovered = await discoverConfig({ ...options, cwd, env, platform });
    files.push(...new Set([...discovered.files, ...discovered.warningFiles]));
    servers = discovered.servers;
    for (const file of discovered.warningFiles) {
      checks.push({ status: "error", target: file, message: "Could not fully read or parse this configuration. Inspect this file locally; parser excerpts are withheld." });
    }
  }
  // A wrapper entry is expected in the agent config; only its upstreams matter here.
  const wrappers = await Promise.all(servers.map((server) => isWrapper(server, cwd)));
  const upstreams = servers.filter((_, index) => !wrappers[index]);
  if (upstreams.length === 0) checks.push({ status: "error", target: "configuration", message: "No upstream MCP servers found. Add a server to your agent config, or use --config <file>. Try cm demo without configuration." });
  for (const server of upstreams) {
    const target = server.name;
    const missing = unresolvedVariables(server);
    if (missing.length) checks.push({ status: "error", target, message: `Unresolved environment variables: ${missing.join(", ")}. Set them in the environment that starts MCPtoCodeMode.` });
    if (server.transport === "stdio") {
      const serverCwd = path.resolve(cwd, server.cwd ?? ".");
      // POSIX spawning searches the system default when PATH is absent, but
      // an explicitly empty PATH searches only the working directory.
      const searchPath = server.env?.PATH ?? env.PATH ?? (platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin");
      const launchEnv = { PATH: searchPath.split(path.delimiter).map((entry) => path.resolve(serverCwd, entry)).join(path.delimiter) };
      if (!(await isDirectory(serverCwd))) {
        checks.push({ status: "error", target, message: "The working directory is missing or is not a directory. Fix cwd in this server's config." });
        continue;
      }
      const command = server.command ?? "";
      const hasPath = command.includes("/") || command.includes("\\");
      const found = hasPath
        ? await isExecutable(path.resolve(serverCwd, command))
        : (await onPath({ env: launchEnv, platform }, command)) !== undefined;
      checks.push(found
        ? { status: "ok", target, message: "Local executable found. Startup and tool access have not been tested." }
        : { status: "error", target, message: "Local executable not found or not executable. Install it or fix command/PATH in this server's config." });
    } else {
      let url: URL;
      try {
        url = new URL(server.url ?? "");
      } catch {
        checks.push({ status: "error", target, message: "Invalid remote URL. Set an absolute http:// or https:// URL." });
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        checks.push({ status: "error", target, message: "Unsupported remote URL scheme. Use http:// or https://." });
      } else {
        checks.push({ status: "ok", target, message: "Remote URL is valid. Connectivity and sign-in have not been tested." });
      }
    }
  }
  return { ok: !checks.some((check) => check.status === "error"), files, servers: upstreams.length, checks };
}

export function formatDiagnosis(report: DoctorReport): string {
  return [
    "MCPtoCodeMode configuration check", "",
    ...report.files.map((file) => `Config: ${printable(file)}`), "",
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${printable(check.target)}: ${check.message}`), "",
    `${report.files.length} config file(s), ${report.servers} upstream server(s). ${report.ok ? "No configuration blockers found." : "Fix the errors above and run doctor again."}`,
    "No servers started, network requests made, or files changed.",
    "To test connections, run cm list. Commands, arguments, URLs, headers, and environment values are omitted here.", "",
  ].join("\n");
}

function unresolvedVariables(server: ServerSpec): string[] {
  const values = [server.command, server.cwd, server.url, ...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})];
  const names = new Set<string>();
  for (const value of values) {
    for (const match of value?.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g) ?? []) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

async function isWrapper(server: ServerSpec, cwd: string): Promise<boolean> {
  const command = path.basename(server.command ?? "").replace(/\.(cmd|exe)$/i, "");
  if (((command === "mcptocodemode" || command === "cm") && server.args?.[0] === "serve") ||
    ((command === "npx" || command === "pnpm") && (server.args ?? []).some((arg) => /^mcptocodemode(?:@[^/]+)?$/.test(arg)) && (server.args ?? []).includes("serve"))) return true;
  // Also recognize the source-style launch without executing it. Match this
  // package's entrypoint by real path, not an arbitrary file named cli.js.
  if (command !== "node") return false;
  const args = server.args ?? [];
  const index = nodeScriptIndex(args);
  if (index === undefined || args[index + 1] !== "serve") return false;
  const entrypoint = args[index];
  if (!entrypoint) return false;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const script = path.resolve(cwd, server.cwd ?? ".", entrypoint);
  const actual = await realpath(script).catch(() => undefined);
  if (!actual) return false;
  for (const entry of ["dist/cli.js", "src/cli.ts"]) {
    if (actual === await realpath(path.join(root, entry)).catch(() => undefined)) return true;
  }
  return false;
}

/** Conservative recognition: unknown options and inline programs need a live connection check. */
function nodeScriptIndex(args: string[]): number | undefined {
  const switches = new Set([
    "--enable-source-maps", "--no-enable-source-maps", "--no-warnings", "--trace-warnings",
    "--trace-deprecation", "--no-deprecation", "--throw-deprecation", "--expose-gc",
    "--preserve-symlinks", "--preserve-symlinks-main", "--experimental-strip-types",
    "--experimental-transform-types", "--inspect", "--inspect-brk", "--inspect-wait",
  ]);
  const valued = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--env-file-if-exists"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index + 1;
    if (!arg.startsWith("-")) return index;
    if (switches.has(arg)) continue;
    if (valued.has(arg)) { index += 1; continue; }
    const option = arg.slice(0, arg.indexOf("="));
    if (arg.includes("=") && (switches.has(option) || valued.has(option))) continue;
    return undefined;
  }
  return undefined;
}

async function isDirectory(file: string): Promise<boolean> {
  return stat(file).then((info) => info.isDirectory(), () => false);
}

function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}
