import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerSpec } from "./config.js";
import type { ListedTool } from "./types.js";

/** Bump when the stored shape changes. Old entries are then ignored. */
const FORMAT = 2;

/**
 * Tool lists from earlier connects, one entry per server spec. A server with
 * an entry can be searched and described without launching it.
 */
export type CatalogCache = {
  read(spec: ServerSpec): ListedTool[] | undefined;
  write(spec: ServerSpec, tools: ListedTool[]): void;
  /** True when this spec turned out to launch mcptocodemode itself. */
  isSelf(spec: ServerSpec): boolean;
  markSelf(spec: ServerSpec): void;
};

/**
 * Key for one spec. Everything that changes what the server could answer is
 * hashed, headers and env included, so a new token or a new version pin is a
 * new entry. Only the hash is written. Secrets never reach the cache file.
 */
export function specKey(spec: ServerSpec): string {
  const identity = {
    format: FORMAT,
    name: spec.name,
    transport: spec.transport,
    command: spec.command ?? null,
    args: spec.args ?? [],
    env: sorted(spec.env),
    cwd: spec.cwd ?? null,
    url: spec.url ?? null,
    headers: sorted(spec.headers),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

/** `CODEMODE_CACHE_DIR`, else `$XDG_CACHE_HOME/mcptocodemode`, else `~/.cache/mcptocodemode`. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.CODEMODE_CACHE_DIR) return env.CODEMODE_CACHE_DIR;
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "mcptocodemode");
}

/** A cache in a directory. A missing or unreadable entry is a miss, and a failed write is ignored. */
export function fileCache(dir: string): CatalogCache {
  const file = (spec: ServerSpec) => path.join(dir, `${specKey(spec)}.json`);
  const load = (spec: ServerSpec): { format?: unknown; tools?: unknown; self?: unknown } | undefined => {
    try {
      return JSON.parse(readFileSync(file(spec), "utf8")) as { format?: unknown; tools?: unknown; self?: unknown };
    } catch {
      return undefined;
    }
  };
  const store = (spec: ServerSpec, body: Record<string, unknown>) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = file(spec);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ format: FORMAT, server: spec.name, savedAt: new Date().toISOString(), ...body })}\n`, {
        mode: 0o600,
      });
      renameSync(temp, target);
    } catch {
      // The cache only saves time. Serving continues without it.
    }
  };
  return {
    read(spec) {
      const stored = load(spec);
      if (stored?.format !== FORMAT || !Array.isArray(stored.tools)) return undefined;
      const tools = stored.tools.filter(
        (tool): tool is ListedTool => typeof tool === "object" && tool !== null && typeof tool.name === "string",
      );
      return tools.length === stored.tools.length ? tools : undefined;
    },
    write(spec, tools) {
      store(spec, { tools });
    },
    isSelf(spec) {
      const stored = load(spec);
      return stored?.format === FORMAT && stored.self === true;
    },
    markSelf(spec) {
      store(spec, { self: true });
    },
  };
}

function sorted(record: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
}
