import { mkdtemp, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodeMode } from "../src/codemode.js";
import type { ServerSpec } from "../src/config.js";
import { installServer } from "../src/install.js";
import { NeedsLoginError } from "../src/oauth.js";
import { login, logout, UpstreamPool } from "../src/upstream.js";
// @ts-expect-error A plain .mjs fixture without types.
import { startOAuthServer } from "./fixtures/oauth-mcp.mjs";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Stands in for the browser: follow the authorization redirect to the loopback callback. */
async function approve(url: URL): Promise<void> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`No redirect from ${url}: ${response.status}`);
  await fetch(location);
}

describe("OAuth sign-in", () => {
  it("fails without a sign-in, signs in through the browser flow, connects, and forgets", async () => {
    const upstream = await startOAuthServer();
    const dir = await mkdtemp(path.join(tmpdir(), "codemode-oauth-"));
    const spec: ServerSpec = { name: "secure", transport: "http", url: upstream.url };
    try {
      // serve, before login: a clear message, no browser, and no client registered upstream.
      const before = await UpstreamPool.connect([spec], { oauthDir: dir });
      expect(before.failures[0]?.message).toContain("secure needs you to sign in. Run: npx mcptocodemode login secure");
      expect(upstream.clients()).toBe(0);
      await before.close();

      const opened: string[] = [];
      const port = await freePort();
      const first = await login(spec, { dir, port, open: async (url) => {
        opened.push(url.origin);
        await approve(url);
      } });
      expect(first).toEqual({ tools: 1, alreadySignedIn: false });
      expect(opened).toHaveLength(1);
      expect(upstream.clients()).toBe(1);
      const [file] = await readdir(dir);
      expect(((await stat(path.join(dir, file ?? ""))).mode & 0o777).toString(8)).toBe("600");

      // serve, after login: connects with the saved tokens.
      const pool = await UpstreamPool.connect([spec], { oauthDir: dir });
      const mode = new CodeMode(pool.catalog, (call) => pool.call(call, 20_000));
      const result = await mode.execute(`return await secure.whoami();`);
      expect(result.ok).toBe(true);
      expect((result.result as { client: string | null }).client).toBeTruthy();
      mode.close();
      await pool.close();

      const again = await login(spec, { dir, port, open: () => {
        throw new Error("should not open a browser when already signed in");
      } });
      expect(again).toEqual({ tools: 1, alreadySignedIn: true });

      logout(spec, { dir });
      const after = await UpstreamPool.connect([spec], { oauthDir: dir });
      expect(after.failures[0]?.message).toContain("needs you to sign in");
      await after.close();
    } finally {
      await upstream.close();
    }
  }, 30_000);

  it("saves a remote server that needs a sign-in and says how to sign in", async () => {
    const saved: string[] = [];
    const remote = {
      name: "com.acme/mcp",
      description: "",
      version: "1.0.0",
      publisher: "owner" as const,
      install: [{ kind: "remote" as const, display: "https://mcp.acme.com", needs: [], spec: (name: string) => ({ name, transport: "http" as const, url: "https://mcp.acme.com" }) }],
    };
    await expect(
      installServer("com.acme/mcp", {
        lookup: async () => remote,
        connect: async () => {
          throw new Error("mcp did not connect", { cause: new NeedsLoginError("mcp") });
        },
        confirm: async () => true,
        persist: async (name) => {
          saved.push(name);
        },
      }),
    ).rejects.toThrow('com.acme/mcp is saved as "acme" and needs you to sign in. Run: npx mcptocodemode login acme');
    expect(saved).toEqual(["acme"]);
  });
});
