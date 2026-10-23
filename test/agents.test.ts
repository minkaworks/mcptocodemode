import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectAgents } from "../src/agents.js";
import { runSetup } from "../src/setup.js";

/** A machine with fake agent CLIs that record their arguments, and empty config files. */
async function machine(tools: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "codemode-agents-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  for (const tool of tools) {
    const file = path.join(bin, tool);
    await writeFile(file, `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
    await chmod(file, 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { home, env, calls };
}

describe("coding agents", () => {
  it("detects agents by their CLI or config directory and knows which already have codemode", async () => {
    const { home, env } = await machine(["claude", "codex"]);
    await writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { codemode: { command: "x" } } }));
    const agents = await detectAgents({ home, env, platform: "linux" });
    const byId = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
    expect(agents.filter((agent) => agent.detected).map((agent) => agent.id)).toEqual(["claude-code", "codex", "cursor"]);
    expect(byId.cursor?.added).toBe(true);
    expect(byId["claude-code"]?.added).toBe(false);
  });

  it("adds through each agent's own command, edits Cursor's file with a backup, and removes again", async () => {
    const { home, env, calls } = await machine(["claude", "codex", "grok", "pi", "opencode"]);
    await writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    const result = await runSetup({ home, env, platform: "linux", yes: true, interactive: false, launch: "npx", readOnly: true });
    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual(["claude-code", "codex", "cursor", "grok", "opencode", "pi"]);

    const recorded = await calls();
    const npx = expect.stringMatching(/npx -y mcptocodemode serve --read-only$/);
    expect(recorded.find((line) => line.startsWith("claude "))).toEqual(expect.stringMatching(/^claude mcp add -s user codemode -- .*npx -y mcptocodemode serve --read-only$/));
    expect(recorded.find((line) => line.startsWith("codex "))).toEqual(expect.stringMatching(/^codex mcp add codemode -- /));
    expect(recorded.find((line) => line.startsWith("grok "))).toEqual(expect.stringMatching(/^grok mcp add codemode \S*npx -- -y mcptocodemode serve --read-only$/));
    expect(recorded.find((line) => line.startsWith("pi "))).toEqual(npx);
    expect(recorded.find((line) => line.startsWith("opencode "))).toEqual(expect.stringMatching(/^opencode mcp add --global codemode -- /));

    const cursor = JSON.parse(await readFile(path.join(home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, { args?: string[] }> };
    expect(Object.keys(cursor.mcpServers)).toEqual(["other", "codemode"]);
    expect(cursor.mcpServers.codemode?.args).toEqual(["-y", "mcptocodemode", "serve", "--read-only"]);
    expect(JSON.parse(await readFile(path.join(home, ".cursor", "mcp.json.mcptocodemode.bak"), "utf8"))).toEqual({ mcpServers: { other: { command: "keep" } } });

    const removed = await runSetup({ home, env, platform: "linux", yes: true, interactive: false, remove: true, agents: ["cursor"] });
    expect(removed.changed).toEqual(["cursor"]);
    const after = JSON.parse(await readFile(path.join(home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual(["other"]);
  });

  it("only touches the agents asked for, changes nothing on a dry run, and refuses to rewrite a commented file", async () => {
    const { home, env, calls } = await machine(["claude", "opencode"]);
    const dry = await runSetup({ home, env, platform: "linux", yes: true, interactive: false, dryRun: true });
    expect(dry.changed).toEqual([]);
    expect(await calls()).toEqual([]);

    const one = await runSetup({ home, env, platform: "linux", yes: true, interactive: false, agents: ["claude-code"], launch: "npx" });
    expect(one.changed).toEqual(["claude-code"]);
    expect((await calls()).every((line) => line.startsWith("claude "))).toBe(true);

    const opencode = path.join(home, ".config", "opencode");
    await mkdir(opencode, { recursive: true });
    await writeFile(path.join(opencode, "opencode.jsonc"), '{\n  // mine\n  "mcp": { "codemode": { "type": "local", "command": ["x"] } }\n}\n');
    const removal = await runSetup({ home, env, platform: "linux", yes: true, interactive: false, remove: true, agents: ["opencode"] });
    expect(removal.failed).toEqual(["opencode"]);
    expect(await readFile(path.join(opencode, "opencode.jsonc"), "utf8")).toContain("// mine");
  });

  it("does nothing without a terminal unless told --yes", async () => {
    const { home, env, calls } = await machine(["claude"]);
    const result = await runSetup({ home, env, platform: "linux", interactive: false });
    expect(result.changed).toEqual([]);
    expect(await calls()).toEqual([]);
  });
});
