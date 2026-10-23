import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodeMode } from "../src/codemode.js";
import { configEntry, installServer, saveServer, type InstallContext } from "../src/install.js";
import type { RegistryServer } from "../src/registry.js";
import { UpstreamPool } from "../src/upstream.js";

const fixture = fileURLToPath(new URL("./fixtures/tiny-mcp.mjs", import.meta.url));

/** A registry entry that launches the local fixture and needs one secret. */
const tiny: RegistryServer = {
  name: "io.github.acme/tiny",
  description: "Pong.",
  version: "1.2.3",
  repository: "https://github.com/acme/tiny",
  publisher: "owner",
  install: [
    {
      kind: "npm",
      display: "npx -y @acme/tiny@1.2.3",
      needs: [{ name: "TINY_TOKEN", secret: true }],
      spec: (name, env) => ({ name, transport: "stdio", command: process.execPath, args: [fixture], env: { TINY_TOKEN: String(env.TINY_TOKEN) } }),
    },
  ],
};

function context(pool: UpstreamPool, answer: boolean, saved: Array<[string, unknown]>, env: NodeJS.ProcessEnv): InstallContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (name) => (name === tiny.name ? tiny : undefined),
    connect: (spec) => pool.add(spec),
    confirm: async (request) => {
      asked.push(request.message);
      return answer;
    },
    persist: async (name, entry) => {
      saved.push([name, entry]);
    },
    env,
    savedTo: "/home/me/.config/mcptocodemode/servers.json",
  };
}

describe("install", () => {
  it("asks, connects the server now, binds it in the same run, and saves it without the secret", async () => {
    const pool = UpstreamPool.start([]);
    const saved: Array<[string, unknown]> = [];
    const ctx = context(pool, true, saved, { TINY_TOKEN: "s3cret" });
    const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000), { install: (name) => installServer(name, ctx) });
    try {
      const result = await mode.execute(`
        const installed = await codemode.install("io.github.acme/tiny");
        return { installed, pong: await tiny.ping() };
      `);
      expect(result).toMatchObject({ ok: true, result: { installed: { server: "tiny", methods: ["ping"] }, pong: { ok: true } } });
      expect(ctx.asked[0]).toContain("Install io.github.acme/tiny 1.2.3 from the MCP registry?");
      expect(ctx.asked[0]).toContain("Publisher: io.github.acme, which also owns https://github.com/acme/tiny");
      expect(ctx.asked[0]).toContain("Runs: npx -y @acme/tiny@1.2.3");
      expect(ctx.asked[0]).toContain("Reads from your environment: TINY_TOKEN");
      expect(saved).toHaveLength(1);
      expect(JSON.stringify(saved)).not.toContain("s3cret");
      expect(JSON.stringify(saved)).toContain("${TINY_TOKEN}");
    } finally {
      mode.close();
      await pool.close();
    }
  }, 20_000);

  it("connects nothing when the person declines or a secret is missing", async () => {
    const pool = UpstreamPool.start([]);
    const saved: Array<[string, unknown]> = [];
    const declined = context(pool, false, saved, { TINY_TOKEN: "x" });
    await expect(installServer("io.github.acme/tiny", declined)).rejects.toThrow("Installing io.github.acme/tiny was declined.");
    const missing = context(pool, true, saved, {});
    await expect(installServer("io.github.acme/tiny", missing)).rejects.toThrow(
      "io.github.acme/tiny needs TINY_TOKEN. Set it in the environment mcptocodemode runs in and try again, or run: npx mcptocodemode add io.github.acme/tiny",
    );
    expect(missing.asked).toEqual([]);
    await expect(installServer("io.github.acme/nope", missing)).rejects.toThrow('No server named "io.github.acme/nope"');
    expect(pool.catalog.servers).toEqual([]);
    expect(saved).toEqual([]);
    await pool.close();
  });

  it("keeps the session clock still while the person decides", async () => {
    const pool = UpstreamPool.start([]);
    const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000), {
      install: () => new Promise((resolve) => setTimeout(() => resolve({ server: "slow" }), 400)),
    });
    expect(await mode.execute(`return await codemode.install("x");`, { timeoutMs: 150 })).toMatchObject({ ok: true, result: { server: "slow" } });
    const off = new CodeMode(pool.catalog, async () => null);
    const refused = await off.execute(`return await codemode.install("x");`);
    expect(refused.error).toContain("Start mcptocodemode with --registry");
    mode.close();
    off.close();
    await pool.close();
  });

  it("saves an entry next to the servers already in the file", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "codemode-config-")), "nested", "servers.json");
    await saveServer(file, "first", { command: "a" });
    await saveServer(file, "tiny", configEntry(tiny, tiny.install[0]!));
    const saved = JSON.parse(await readFile(file, "utf8")) as { mcpServers: Record<string, { env?: unknown; registry?: string }> };
    expect(Object.keys(saved.mcpServers)).toEqual(["first", "tiny"]);
    expect(saved.mcpServers.tiny).toMatchObject({ env: { TINY_TOKEN: "${TINY_TOKEN}" }, registry: "io.github.acme/tiny@1.2.3" });
    await writeFile(file, "{ broken");
    await expect(saveServer(file, "x", {})).rejects.toThrow("Could not read");
  });
});
