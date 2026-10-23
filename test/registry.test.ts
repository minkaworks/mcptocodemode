import { describe, expect, it } from "vitest";
import { availableServer, RegistryClient } from "../src/registry.js";

const official = { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } };

const body = {
  servers: [
    {
      server: {
        name: "io.github.someone/github-mcp-server",
        description: "A copy.",
        version: "1.0.0",
        repository: { url: "https://github.com/github/github-mcp-server" },
        remotes: [{ type: "streamable-http", url: "https://copy.example.com/mcp" }],
      },
      _meta: official,
    },
    {
      server: {
        name: "io.github.github/github-mcp-server",
        description: "Connect AI assistants to GitHub.",
        version: "2.0.3",
        repository: { url: "https://github.com/github/github-mcp-server" },
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/github/github-mcp-server:2.0.3",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", isRequired: true, isSecret: true }],
          },
        ],
      },
      _meta: official,
    },
    {
      server: {
        name: "io.github.acme/notes",
        version: "0.3.0",
        repository: { url: "https://github.com/acme/notes" },
        packages: [
          { registryType: "npm", identifier: "@acme/notes-mcp", version: "0.3.0", packageArguments: [{ type: "positional", value: "--stdio" }] },
          { registryType: "pypi", identifier: "acme-notes", version: "0.3.0" },
          { registryType: "npm", identifier: "@acme/needs-input", packageArguments: [{ type: "positional", isRequired: true }] },
        ],
      },
      _meta: official,
    },
    { server: { name: "io.github.old/gone", remotes: [{ url: "https://gone.example.com" }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } },
  ],
};

function client(responses: Record<string, unknown>) {
  const seen: string[] = [];
  const registry = new RegistryClient({
    url: "https://registry.test",
    fetch: (async (url: string) => {
      seen.push(url);
      const path = url.replace("https://registry.test", "");
      const key = Object.keys(responses).find((prefix) => path.startsWith(prefix));
      if (!key) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(responses[key]), { status: 200 });
    }) as typeof fetch,
  });
  return { registry, seen };
}

describe("registry", () => {
  it("lists latest active servers, publisher-owned first, and turns each package into a launch spec", async () => {
    const { registry, seen } = client({ "/v0/servers?": body });
    const found = await registry.search("github", 10);
    expect(seen[0]).toBe("https://registry.test/v0/servers?search=github&version=latest&limit=30");
    expect(found.map((server) => server.name)).toEqual([
      "io.github.github/github-mcp-server",
      "io.github.someone/github-mcp-server",
      "io.github.acme/notes",
    ]);
    const [github, copy, notes] = found;
    expect(github?.publisher).toBe("owner");
    expect(copy?.publisher).toBe("namespace");

    const docker = github?.install[0];
    expect(docker?.display).toBe("docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server:2.0.3");
    expect(docker?.spec("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "t0k" })).toEqual({
      name: "github",
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:2.0.3"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "t0k" },
    });
    expect(notes?.install.map((option) => option.display)).toEqual(["npx -y @acme/notes-mcp@0.3.0 --stdio", "uvx acme-notes==0.3.0"]);
    expect(copy?.install[0]?.spec("copy", {})).toEqual({ name: "copy", transport: "http", url: "https://copy.example.com/mcp" });

    // A repeated search is served from memory.
    await registry.search("GitHub ");
    expect(seen).toHaveLength(1);
  });

  it("summarizes a server for the model, with what it needs and whether that is set", async () => {
    const { registry } = client({ "/v0/servers?": body });
    const [github] = await registry.search("github");
    expect(availableServer(github!, {})).toMatchObject({ name: "io.github.github/github-mcp-server", needs: ["GITHUB_PERSONAL_ACCESS_TOKEN"], ready: false });
    expect(availableServer(github!, { GITHUB_PERSONAL_ACCESS_TOKEN: "x" }).ready).toBe(true);
  });

  it("looks a server up by name and reports a missing one as undefined", async () => {
    const { registry, seen } = client({ "/v0/servers/io.github.acme%2Fnotes/versions/latest": body.servers[2] });
    expect((await registry.get("io.github.acme/notes"))?.version).toBe("0.3.0");
    expect(seen[0]).toBe("https://registry.test/v0/servers/io.github.acme%2Fnotes/versions/latest");
    expect(await registry.get("io.github.acme/nothing")).toBeUndefined();
  });

  it("gives up on a registry that does not answer", async () => {
    const registry = new RegistryClient({
      timeoutMs: 50,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
    });
    await expect(registry.search("slow")).rejects.toThrow("did not answer within 50 ms");
  });

  it("keeps a local index: full sync first, then only what changed, and searches it without the network", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const indexFile = path.join(await mkdtemp(path.join(tmpdir(), "codemode-index-")), "registry-index.json");
    const requests: string[] = [];
    let phase = "full";
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      const query = new URL(url).searchParams;
      if (phase === "full") {
        const page = query.get("cursor") === "p2" ? [body.servers[2]] : [body.servers[0], body.servers[1]];
        return new Response(JSON.stringify({ servers: page, metadata: query.get("cursor") ? {} : { nextCursor: "p2" } }));
      }
      // The incremental sync: acme/notes was deleted upstream.
      return new Response(JSON.stringify({
        servers: [{ server: { name: "io.github.acme/notes" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } }],
        metadata: {},
      }));
    }) as typeof fetch;

    const registry = new RegistryClient({ url: "https://registry.test", fetch: fetchImpl, indexFile });
    // Before the first sync, search asks the registry and starts building the index.
    await registry.search("github");
    expect(requests[0]).toContain("search=github");
    await registry.sync();
    expect(requests.every((url) => url.includes("version=latest") && !url.includes("updated_since"))).toBe(true);
    const before = requests.length;
    expect((await registry.search("github", 10)).map((server) => server.name)).toEqual([
      "io.github.github/github-mcp-server",
      "io.github.someone/github-mcp-server",
    ]);
    expect((await registry.search("acme")).map((server) => server.name)).toEqual(["io.github.acme/notes"]);
    expect(requests.length).toBe(before);

    // A new client reads the index from disk, and the next sync asks only for changes.
    phase = "incremental";
    const reopened = new RegistryClient({ url: "https://registry.test", fetch: fetchImpl, indexFile });
    expect((await reopened.search("acme")).length).toBe(1);
    const result = await reopened.sync();
    expect(result).toEqual({ servers: 2, full: false });
    expect(requests.at(-1)).toContain("updated_since=");
    expect(await reopened.search("acme")).toEqual([]);
  });

  it("follows runtime arguments: fixed flags, optional tokens passed by name, and full docker commands", async () => {
    const { registry } = client({
      "/v0/servers?": {
        servers: [
          {
            server: {
              name: "io.github.github/github-mcp-server",
              version: "2.0.3",
              repository: { url: "https://github.com/github/github-mcp-server" },
              packages: [
                {
                  registryType: "oci",
                  identifier: "ghcr.io/github/github-mcp-server:2.0.3",
                  transport: { type: "stdio" },
                  runtimeArguments: [
                    { type: "named", name: "-p", value: "127.0.0.1:8085:8085" },
                    { type: "named", name: "-e", value: "GITHUB_OAUTH_CALLBACK_PORT=8085" },
                    { type: "named", name: "-e", value: "GITHUB_PERSONAL_ACCESS_TOKEN={token}", variables: { token: { isSecret: true } } },
                  ],
                },
              ],
            },
          },
          {
            server: {
              name: "io.github.old/full-docker",
              version: "0.16.0",
              packages: [
                {
                  registryType: "oci",
                  identifier: "ghcr.io/old/server:0.16.0",
                  runtimeArguments: [
                    { type: "positional", value: "run" },
                    { type: "named", name: "-i" },
                    { type: "named", name: "--rm" },
                    { type: "named", name: "-e" },
                    { type: "positional", value: "OLD_TOKEN" },
                    { type: "positional", value: "ghcr.io/old/server" },
                  ],
                  environmentVariables: [{ name: "OLD_TOKEN", isRequired: true, isSecret: true }],
                },
              ],
            },
          },
        ],
      },
    });
    const [github, old] = await registry.search("github docker", 10).then((list) =>
      ["io.github.github/github-mcp-server", "io.github.old/full-docker"].map((name) => list.find((item) => item.name === name)),
    );
    const option = github?.install[0];
    expect(option?.display).toBe(
      "docker run -i --rm -p 127.0.0.1:8085:8085 -e GITHUB_OAUTH_CALLBACK_PORT=8085 [-e GITHUB_PERSONAL_ACCESS_TOKEN] ghcr.io/github/github-mcp-server:2.0.3",
    );
    expect(option?.needs).toEqual([]);
    expect(option?.optional).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(option?.spec("github", {}).args).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    const withToken = option?.spec("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "t" });
    expect(withToken?.args).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(withToken?.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "t" });
    expect(JSON.stringify(withToken?.args)).not.toContain('"t"');

    expect(old?.install[0]?.display).toBe("docker run -i --rm -e OLD_TOKEN ghcr.io/old/server:0.16.0");
    expect(old?.install[0]?.needs.map((need) => need.name)).toEqual(["OLD_TOKEN"]);
  });
});

