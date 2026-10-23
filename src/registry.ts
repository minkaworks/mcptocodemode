import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerSpec } from "./config.js";

/** The official MCP registry. */
export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

type RegistryArgument = {
  type?: string;
  name?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
  /** Inputs for `{name}` placeholders in `value`. */
  variables?: Record<string, { isRequired?: boolean; isSecret?: boolean }>;
};

type RegistryEnvVar = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
};

type RegistryPackage = {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryEnvVar[];
};

type RegistryRemote = {
  type?: string;
  url?: string;
  headers?: Array<{ name: string; isRequired?: boolean; isSecret?: boolean; value?: string }>;
};

type RegistryEntry = {
  server: {
    name: string;
    description?: string;
    version?: string;
    repository?: { url?: string; source?: string };
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
  };
  _meta?: Record<string, { status?: string; isLatest?: boolean } | undefined>;
};

/** One way to run a registry server, already turned into what UpstreamPool launches. */
export type InstallOption = {
  kind: "npm" | "pypi" | "oci" | "remote";
  /** The command line or URL, shown to a person before anything runs. */
  display: string;
  /** Environment variables or headers the server needs. Secrets are marked. */
  needs: Array<{ name: string; secret: boolean; description?: string }>;
  /** Variables passed through only when set, such as a token that replaces an OAuth sign-in. */
  optional?: string[];
  spec: (name: string, env: NodeJS.ProcessEnv) => ServerSpec;
};

/**
 * How much the registry vouches for who published a server. Every namespace is
 * verified to someone: `io.github.acme/*` only by the GitHub account `acme`,
 * `com.acme/*` only by whoever controls acme.com. `owner` means the publisher
 * also owns the repository the entry points at, so it is not a republish.
 */
export type Publisher = "owner" | "namespace";

export type RegistryServer = {
  name: string;
  description: string;
  version: string;
  repository?: string;
  publisher: Publisher;
  install: InstallOption[];
};

export type RegistryOptions = {
  url?: string;
  /** Per request for lookups and index pages. */
  timeoutMs?: number;
  /** For the registry's own search, which is slow on the official registry. */
  searchTimeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Where to keep a local index of the registry. With it, search runs locally
   * and `sync` keeps it current. Without it, search asks the registry each
   * time, which takes 20 to 40 seconds on the official one.
   */
  indexFile?: string;
  /** With an index file and no index yet, a search starts building it in the background. Default true. */
  syncOnSearch?: boolean;
};

/** Bump when the stored index shape changes. */
const INDEX_FORMAT = 1;

type IndexFile = { format: number; url: string; syncedAt: string; servers: RegistryEntry["server"][] };

/** Search and look up servers in an MCP registry. */
export class RegistryClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly indexFile?: string;
  private readonly syncOnSearch: boolean;
  /** Stored entries with the text search matches against. Normalized only when they match. */
  private index?: Array<{ server: RegistryEntry["server"]; text: string }>;
  private loaded?: Promise<void>;
  private syncing?: Promise<{ servers: number; full: boolean }>;
  /** Index entries as stored, by name. */
  private raw = new Map<string, RegistryEntry["server"]>();
  private storedSince?: string;
  private readonly searches = new Map<string, Promise<RegistryServer[]>>();

  constructor(options: RegistryOptions = {}) {
    this.url = (options.url ?? DEFAULT_REGISTRY_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.searchTimeoutMs = options.searchTimeoutMs ?? Math.max(this.timeoutMs, 45_000);
    this.fetchImpl = options.fetch ?? fetch;
    this.indexFile = options.indexFile;
    this.syncOnSearch = options.syncOnSearch ?? true;
  }

  /** Latest active versions matching `query`, best fit first. */
  async search(query: string, limit = 5): Promise<RegistryServer[]> {
    const key = query.trim().toLowerCase();
    if (this.indexFile) {
      await this.load();
      if (this.index) return this.searchIndex(key, limit);
      // The first sync takes a while. Until it is done, ask the registry, which is slow but complete.
      if (this.syncOnSearch) void this.sync().catch(() => undefined);
    }
    let pending = this.searches.get(key);
    if (!pending) {
      // The registry matches its search text literally inside names, so "time zone" finds nothing.
      // Send the longest word and rank the results here with all of them.
      const term = queryWords(key).sort((a, b) => b.length - a.length)[0] ?? key;
      pending = this.request(`/v0/servers?search=${encodeURIComponent(term)}&version=latest&limit=50`, this.searchTimeoutMs).then((body) =>
        rank(entries(body), key),
      );
      // A failed search is not cached, so the next one tries again.
      pending.catch(() => this.searches.delete(key));
      this.searches.set(key, pending);
    }
    return (await pending).slice(0, limit);
  }

  /**
   * Bring the local index up to date: the whole registry the first time, then
   * only what changed since the last sync. One sync runs at a time.
   */
  sync(onProgress?: (servers: number) => void): Promise<{ servers: number; full: boolean }> {
    if (!this.indexFile) return Promise.reject(new Error("sync needs indexFile"));
    this.syncing ??= this.runSync(onProgress).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(onProgress?: (servers: number) => void): Promise<{ servers: number; full: boolean }> {
    await this.load();
    const startedAt = new Date().toISOString();
    const stored = this.storedSince;
    const full = !this.index || !stored;
    const raw = new Map<string, RegistryEntry["server"]>(full ? [] : this.raw);
    let cursor: string | undefined;
    let seen = 0;
    do {
      const params = new URLSearchParams({ version: "latest", limit: "100" });
      if (!full && stored) params.set("updated_since", stored);
      if (cursor) params.set("cursor", cursor);
      const body = (await this.request(`/v0/servers?${params}`)) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string } };
      for (const entry of body.servers ?? []) {
        const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
        if (meta?.status && meta.status !== "active") raw.delete(entry.server.name);
        else raw.set(entry.server.name, compact(entry.server));
      }
      seen += body.servers?.length ?? 0;
      onProgress?.(seen);
      cursor = body.metadata?.nextCursor;
    } while (cursor);
    this.setIndex(raw, startedAt);
    if (this.indexFile) {
      const file: IndexFile = { format: INDEX_FORMAT, url: this.url, syncedAt: startedAt, servers: [...raw.values()] };
      await mkdir(path.dirname(this.indexFile), { recursive: true });
      const temp = `${this.indexFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(file));
      await rename(temp, this.indexFile);
    }
    return { servers: raw.size, full };
  }

  /** True once a local index is loaded or built. */
  async hasIndex(): Promise<boolean> {
    await this.load();
    return this.index !== undefined;
  }

  private setIndex(raw: Map<string, RegistryEntry["server"]>, syncedAt: string): void {
    this.raw = raw;
    this.storedSince = syncedAt;
    this.index = [...raw.values()].map((server) => ({ server, text: searchText(server.name, server.description ?? "") }));
  }

  private searchIndex(query: string, limit: number): RegistryServer[] {
    const words = queryWords(query);
    if (words.length === 0 || !this.index) return [];
    const scored = this.index
      .filter((item) => words.some((word) => item.text.includes(word)))
      .map((item) => ({ item, score: scoreOf(item.server.name, item.server.description ?? "", item.server.repository?.url, words) }))
      .sort((a, b) => b.score - a.score);
    const out: RegistryServer[] = [];
    for (const { item } of scored) {
      const server = normalize({ server: item.server });
      if (server && server.install.length > 0) out.push(server);
      if (out.length >= limit) break;
    }
    return out;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.indexFile) return;
      try {
        const file = JSON.parse(await readFile(this.indexFile, "utf8")) as IndexFile;
        if (file.format !== INDEX_FORMAT || file.url !== this.url || !Array.isArray(file.servers)) return;
        this.setIndex(new Map(file.servers.map((server) => [server.name, server])), file.syncedAt);
      } catch {
        // No index yet, or an unreadable one. The next sync rebuilds it.
      }
    })();
    return this.loaded;
  }

  /** One server by its registry name, latest version. */
  async get(name: string): Promise<RegistryServer | undefined> {
    try {
      const body = await this.request(`/v0/servers/${encodeURIComponent(name)}/versions/latest`);
      const entry = normalize(body as RegistryEntry);
      return entry?.name === name ? entry : undefined;
    } catch (error) {
      if (error instanceof RegistryError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async request(path: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new RegistryError(`registry answered ${response.status}`, response.status);
      return (await response.json()) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw new RegistryError(`registry did not answer within ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What search shows the model for one installable server. */
export type AvailableServer = {
  name: string;
  description: string;
  version: string;
  publisher: Publisher;
  repository?: string;
  runs: string;
  /** How it runs. A remote server may ask for an OAuth sign-in, which mcptocodemode does not do yet. */
  kind: InstallOption["kind"];
  needs: string[];
  /** True when every variable it needs is set, so `codemode.install` can go ahead after confirmation. */
  ready: boolean;
};

export function availableServer(server: RegistryServer, env: NodeJS.ProcessEnv = process.env): AvailableServer {
  const ready = server.install.find((option) => option.needs.every((need) => env[need.name] !== undefined));
  const option = ready ?? server.install[0];
  const description = server.description.length > 160 ? `${server.description.slice(0, 159)}…` : server.description;
  return {
    name: server.name,
    description,
    version: server.version,
    publisher: server.publisher,
    ...(server.repository ? { repository: server.repository } : {}),
    runs: option?.display ?? "",
    kind: option?.kind ?? "remote",
    needs: option?.needs.map((need) => need.name) ?? [],
    ready: ready !== undefined,
  };
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The fields an index keeps from each registry entry. */
function compact(server: RegistryEntry["server"]): RegistryEntry["server"] {
  return {
    name: server.name,
    ...(server.description ? { description: server.description } : {}),
    ...(server.version ? { version: server.version } : {}),
    ...(server.repository?.url ? { repository: { url: server.repository.url } } : {}),
    ...(server.packages?.length ? { packages: server.packages } : {}),
    ...(server.remotes?.length ? { remotes: server.remotes } : {}),
  };
}

function entries(body: unknown): RegistryServer[] {
  const list = (body as { servers?: RegistryEntry[] } | undefined)?.servers ?? [];
  const byName = new Map<string, RegistryServer>();
  for (const entry of list) {
    const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
    if (meta?.status && meta.status !== "active") continue;
    const server = normalize(entry);
    if (server && server.install.length > 0 && !byName.has(server.name)) byName.set(server.name, server);
  }
  return [...byName.values()];
}

/** True when the publisher is the brand a query names: com.supabase or io.github.supabase for "supabase". */
export function isVendor(name: string, query: string): boolean {
  const label = publisherLabel((name.split("/")[0] ?? "").toLowerCase());
  return queryWords(query.toLowerCase()).includes(label);
}

function queryWords(query: string): string[] {
  return query.split(/[^a-z0-9]+/).filter((word) => word.length > 1);
}

/** The publisher label: `github` for io.github.github, `stripe` for com.stripe. */
function publisherLabel(namespace: string): string {
  const github = /^io\.github\.(.+)$/.exec(namespace)?.[1];
  if (github) return github;
  return namespace.split(".")[1] ?? namespace;
}

/** Lowercase short name, publisher, and description, for matching. */
function searchText(name: string, description: string): string {
  const [namespace = "", short = ""] = name.toLowerCase().split("/");
  return `${short} ${publisherLabel(namespace)} ${description.toLowerCase()}`;
}

/**
 * How well a server fits the query. The strongest signal is a publisher that
 * is the vendor itself: io.github.github or com.stripe for those words. Then
 * the short name, the description, and a publisher who owns the repository.
 */
function scoreOf(name: string, description: string, repository: string | undefined, words: string[]): number {
  const [namespace = "", short = ""] = name.toLowerCase().split("/");
  const label = publisherLabel(namespace);
  const text = description.toLowerCase();
  let total = publisherOf(name, repository) === "owner" ? 2 : 0;
  for (const word of words) {
    // The namespace is verified against that GitHub account or domain, so this is the vendor.
    if (label === word) total += 12;
    else if (label.includes(word)) total += 2;
    // `github`, `github-mcp`, `mcp-github`, `github-mcp-server`: the server for exactly this word.
    if (short.replace(/(^mcp-(server-)?)|(-mcp(-server)?$)/g, "") === word) total += 8;
    else if (short.includes(word)) total += 4;
    if (text.includes(word)) total += 1;
  }
  return total;
}

function rank(servers: RegistryServer[], query: string): RegistryServer[] {
  const words = queryWords(query);
  return servers
    .map((server) => ({ server, score: scoreOf(server.name, server.description, server.repository, words) }))
    .sort((a, b) => b.score - a.score)
    .map(({ server }) => server);
}

function normalize(entry: RegistryEntry | undefined): RegistryServer | undefined {
  const server = entry?.server;
  if (!server?.name) return undefined;
  const version = server.version ?? "latest";
  const repository = server.repository?.url;
  const install = [
    ...(server.packages ?? []).map((pkg) => packageOption(pkg, version)),
    ...(server.remotes ?? []).map((remote) => remoteOption(remote)),
  ].filter((option): option is InstallOption => option !== undefined);
  return {
    name: server.name,
    description: (server.description ?? "").trim(),
    version,
    ...(repository ? { repository } : {}),
    publisher: publisherOf(server.name, repository),
    install,
  };
}

function publisherOf(name: string, repository: string | undefined): Publisher {
  const namespace = name.split("/")[0] ?? "";
  const github = /^io\.github\.([^.]+)$/i.exec(namespace)?.[1];
  const repoOwner = repository ? /github\.com\/([^/]+)\//i.exec(repository)?.[1] : undefined;
  if (github && repoOwner && github.toLowerCase() === repoOwner.toLowerCase()) return "owner";
  // A reverse-DNS namespace (com.acme) is verified against that domain.
  if (!github && repoOwner && namespace.split(".").includes(repoOwner.toLowerCase())) return "owner";
  return "namespace";
}

function needsOf(vars: RegistryEnvVar[] | undefined): InstallOption["needs"] {
  return (vars ?? [])
    .filter((item) => item.isRequired)
    .map((item) => ({ name: item.name, secret: item.isSecret === true, ...(item.description ? { description: item.description } : {}) }));
}

type RenderedArg = { args: string[]; env?: string; required: boolean };

/**
 * Turn registry arguments into argv parts. A fixed value is used as it is. A
 * docker-style `-e NAME={var}` becomes `-e NAME`, so the value is read from
 * the environment and never appears on a command line. Any other templated
 * argument is skipped when optional. Undefined when an argument needs input
 * mcptocodemode cannot supply.
 */
function renderArgs(args: RegistryArgument[] | undefined): RenderedArg[] | undefined {
  const out: RenderedArg[] = [];
  for (const arg of args ?? []) {
    const value = arg.value ?? arg.default;
    const variables = value ? [...value.matchAll(/\{([^}]+)\}/g)].map((found) => found[1] ?? "") : [];
    if (variables.length > 0) {
      const passthrough = arg.type === "named" && arg.name === "-e" ? /^([A-Za-z_][A-Za-z0-9_]*)=\{[^}]+\}$/.exec(value ?? "")?.[1] : undefined;
      const required = arg.isRequired === true || variables.some((name) => arg.variables?.[name]?.isRequired === true);
      if (passthrough) out.push({ args: ["-e", passthrough], env: passthrough, required });
      else if (required) return undefined;
      continue;
    }
    if (arg.type === "named" && arg.name) out.push({ args: [arg.name, ...(value !== undefined ? [value] : [])], required: true });
    else if (value !== undefined) out.push({ args: [value], required: true });
    else if (arg.isRequired) return undefined;
  }
  return out;
}

/** The argv for this environment: optional passthroughs only when their variable is set. */
function argvFor(parts: RenderedArg[], env: NodeJS.ProcessEnv): string[] {
  return parts.flatMap((part) => (part.env && !part.required && env[part.env] === undefined ? [] : part.args));
}

/** How the argv reads to a person: optional passthroughs in brackets. */
function displayOf(parts: RenderedArg[]): string[] {
  return parts.map((part) => (part.env && !part.required ? `[${part.args.join(" ")}]` : part.args.join(" ")));
}

function packageOption(pkg: RegistryPackage, serverVersion: string): InstallOption | undefined {
  if (!pkg.identifier || (pkg.transport?.type && pkg.transport.type !== "stdio")) return undefined;
  const runtime = renderArgs(pkg.runtimeArguments);
  const packageArgs = renderArgs(pkg.packageArguments);
  if (!runtime || !packageArgs) return undefined;
  const version = pkg.version ?? serverVersion;
  const declared = needsOf(pkg.environmentVariables);
  const passthrough = [...runtime, ...packageArgs].filter((part) => part.env);
  const needs = [
    ...declared,
    ...passthrough
      .filter((part) => part.required && !declared.some((need) => need.name === part.env))
      .map((part) => ({ name: part.env as string, secret: true })),
  ];
  const optional = passthrough.filter((part) => !part.required).map((part) => part.env as string);
  const envFor = (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(
      [...needs.map((need) => need.name), ...optional].flatMap((name) => (env[name] !== undefined ? [[name, env[name] as string]] : [])),
    );
  const option = (kind: InstallOption["kind"], command: string, build: (env: NodeJS.ProcessEnv) => string[], shown: string[]): InstallOption => ({
    kind,
    display: [command, ...shown].join(" "),
    needs,
    ...(optional.length > 0 ? { optional } : {}),
    spec: (name, env) => ({ name, transport: "stdio", command, args: build(env), env: envFor(env) }),
  });

  if (pkg.registryType === "npm") {
    const target = `${pkg.identifier}@${version}`;
    return option(
      "npm",
      "npx",
      (env) => [...argvFor(runtime, env), "-y", target, ...argvFor(packageArgs, env)],
      [...displayOf(runtime), "-y", target, ...displayOf(packageArgs)],
    );
  }
  if (pkg.registryType === "pypi") {
    const target = `${pkg.identifier}==${version}`;
    return option(
      "pypi",
      "uvx",
      (env) => [...argvFor(runtime, env), target, ...argvFor(packageArgs, env)],
      [...displayOf(runtime), target, ...displayOf(packageArgs)],
    );
  }
  if (pkg.registryType === "oci") {
    const image = pkg.identifier.includes(":") ? pkg.identifier : `${pkg.identifier}:${version}`;
    const bare = image.replace(/:[^:/]+$/, "");
    // Declared variables pass through by name, so their values never appear on a command line.
    const declaredEnv: RenderedArg[] = declared
      .filter((need) => !passthrough.some((part) => part.env === need.name))
      .map((need) => ({ args: ["-e", need.name], env: need.name, required: true }));
    // Some entries spell out the whole docker command, image included. Use it, with the image pinned.
    const complete = runtime[0]?.args[0] === "run";
    let withImage: RenderedArg[];
    if (complete) {
      const pinned = runtime.map((part) => (part.args.length === 1 && part.args[0] === bare ? { ...part, args: [image] } : part));
      const named = new Set(pinned.flatMap((part) => part.args));
      // Docker options go before the image. Anything after it is the container's own argv.
      const missing = declaredEnv.filter((part) => !named.has(part.env as string));
      const at = pinned.findIndex((part) => part.args.includes(image));
      withImage =
        at === -1
          ? [...pinned, ...missing, { args: [image], required: true }]
          : [...pinned.slice(0, at), ...missing, ...pinned.slice(at)];
    } else {
      withImage = [{ args: ["run", "-i", "--rm"], required: true }, ...runtime, ...declaredEnv, { args: [image], required: true }];
    }
    return option("oci", "docker", (env) => [...argvFor(withImage, env), ...argvFor(packageArgs, env)], [...displayOf(withImage), ...displayOf(packageArgs)]);
  }
  return undefined;
}

function remoteOption(remote: RegistryRemote): InstallOption | undefined {
  if (!remote.url) return undefined;
  const transport = remote.type === "sse" ? "sse" : remote.type === "streamable-http" || !remote.type ? "http" : undefined;
  if (!transport) return undefined;
  const needs = (remote.headers ?? [])
    .filter((header) => header.isRequired && header.value === undefined)
    .map((header) => ({ name: header.name, secret: header.isSecret === true }));
  return {
    kind: "remote",
    display: remote.url,
    needs,
    spec: (name, env) => {
      const headers = Object.fromEntries(
        (remote.headers ?? []).flatMap((header) => {
          const value = header.value ?? env[header.name];
          return value === undefined ? [] : [[header.name, value]];
        }),
      );
      return { name, transport, url: remote.url as string, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    },
  };
}
