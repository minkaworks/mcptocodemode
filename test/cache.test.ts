import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultCacheDir, fileCache, specKey } from "../src/cache.js";
import { CodeMode } from "../src/codemode.js";
import type { ServerSpec } from "../src/config.js";
import { UpstreamPool } from "../src/upstream.js";

const fixture = fileURLToPath(new URL("./fixtures/tiny-mcp.mjs", import.meta.url));
const tiny: ServerSpec = { name: "tiny", command: process.execPath, args: [fixture], transport: "stdio" };

describe("catalog cache", () => {
  it("keys a spec by everything that changes it and never stores a secret", async () => {
    const spec: ServerSpec = { name: "docs", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer s3cret" } };
    expect(specKey(spec)).toBe(specKey({ ...spec, headers: { Authorization: "Bearer s3cret" } }));
    expect(specKey(spec)).not.toBe(specKey({ ...spec, headers: { Authorization: "Bearer other" } }));
    expect(specKey(tiny)).not.toBe(specKey({ ...tiny, args: [fixture, "--flag"] }));

    const dir = await mkdtemp(path.join(tmpdir(), "codemode-cache-"));
    const cache = fileCache(dir);
    cache.write(spec, [{ name: "search", description: "Search docs." }]);
    expect(cache.read(spec)).toEqual([{ name: "search", description: "Search docs." }]);
    const [file] = await readdir(dir);
    expect(await readFile(path.join(dir, file ?? ""), "utf8")).not.toContain("s3cret");
  });

  it("treats a corrupt entry as a miss", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codemode-cache-"));
    await writeFile(path.join(dir, `${specKey(tiny)}.json`), "{ nope");
    expect(fileCache(dir).read(tiny)).toBeUndefined();
  });

  it("picks the cache directory from the environment", () => {
    expect(defaultCacheDir({ CODEMODE_CACHE_DIR: "/c" }, "/home/me")).toBe("/c");
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/x" }, "/home/me")).toBe(path.join("/x", "mcptocodemode"));
    expect(defaultCacheDir({}, "/home/me")).toBe(path.join("/home/me", ".cache", "mcptocodemode"));
  });
});

describe("lazy start", () => {
  it("serves a cached server without launching it until the first call", async () => {
    const cache = fileCache(await mkdtemp(path.join(tmpdir(), "codemode-cache-")));

    const cold = UpstreamPool.start([tiny], { cache });
    await cold.ready;
    expect(cold.connected).toEqual(["tiny"]);
    await cold.close();

    const warm = UpstreamPool.start([tiny], { cache, prewarm: false });
    try {
      await warm.ready;
      expect(warm.connected).toEqual([]);
      expect(warm.catalog.servers[0]?.tools.some((tool) => tool.method === "ping")).toBe(true);

      const mode = new CodeMode(warm.catalog, (call) => warm.call(call, 20_000));
      const result = await mode.execute(`return await tiny.ping();`);
      expect(result).toMatchObject({ ok: true, result: { ok: true } });
      expect(warm.connected).toEqual(["tiny"]);
    } finally {
      await warm.close();
    }
  }, 20_000);

  it("replaces a stale cached tool list when the server connects", async () => {
    const cache = fileCache(await mkdtemp(path.join(tmpdir(), "codemode-cache-")));
    cache.write(tiny, [{ name: "retired", description: "Gone upstream." }]);
    const pool = UpstreamPool.start([tiny], { cache, prewarm: false });
    try {
      const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000));
      const stale = await mode.execute(`return await tiny.retired();`);
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain('no tool "retired"');
      expect(pool.catalog.servers[0]?.tools.map((tool) => tool.method)).toContain("ping");
      expect(cache.read(tiny)?.map((tool) => tool.name)).toEqual(["ping"]);
      expect(await mode.execute(`return await tiny.ping();`)).toMatchObject({ ok: true });
    } finally {
      await pool.close();
    }
  }, 20_000);

  it("reports a cached server that fails on its first call", async () => {
    const broken: ServerSpec = { name: "broken", command: process.execPath, args: ["-e", "process.exit(2)"], transport: "stdio" };
    const cache = fileCache(await mkdtemp(path.join(tmpdir(), "codemode-cache-")));
    cache.write(broken, [{ name: "ping" }]);
    const seen: string[] = [];
    const pool = UpstreamPool.start([broken], { cache, prewarm: false, onFailure: (failure) => seen.push(failure.name) });
    try {
      const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000));
      const result = await mode.execute(`return await broken.ping();`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("broken did not connect");
      expect(seen).toEqual(["broken"]);
      expect(pool.failures.map((failure) => failure.name)).toEqual(["broken"]);
    } finally {
      await pool.close();
    }
  }, 20_000);

  it("prewarms a cached server in the background without holding up ready", async () => {
    const cache = fileCache(await mkdtemp(path.join(tmpdir(), "codemode-cache-")));
    cache.write(tiny, [{ name: "ping" }]);
    const pool = UpstreamPool.start([tiny], { cache });
    try {
      await pool.ready;
      expect(pool.connected).toEqual([]);
      const deadline = Date.now() + 10_000;
      while (pool.connected.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(pool.connected).toEqual(["tiny"]);
    } finally {
      await pool.close();
    }
  }, 20_000);

  it("drops the client's own entry for this server and remembers it", async () => {
    const self: ServerSpec = {
      name: "codemode",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/self-mcp.mjs", import.meta.url))],
      transport: "stdio",
    };
    const cache = fileCache(await mkdtemp(path.join(tmpdir(), "codemode-cache-")));
    const seen: string[] = [];
    const first = UpstreamPool.start([self, tiny], { cache, onFailure: (failure) => seen.push(failure.name) });
    try {
      await first.ready;
      expect(first.catalog.servers.map((server) => server.name)).toEqual(["tiny"]);
      expect(first.failures).toEqual([]);
      expect(seen).toEqual([]);
      expect(cache.isSelf(self)).toBe(true);
      const mode = new CodeMode(first.catalog, (call) => first.call(call, 20_000));
      expect(await mode.execute(`return await tiny.ping();`)).toMatchObject({ ok: true });
    } finally {
      await first.close();
    }

    const second = UpstreamPool.start([self, tiny], { cache, prewarm: false });
    try {
      await second.ready;
      expect(second.catalog.servers.map((server) => server.name)).toEqual(["tiny"]);
      expect(second.connected).toEqual([]);
    } finally {
      await second.close();
    }
  }, 20_000);
});
