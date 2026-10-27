// Install the actual tarball outside the checkout, then exercise its public CLI.
// Build first. Only dependency installation may use the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "codemode-package-"));
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8", timeout: 60_000 }))[0];
  const install = path.join(temp, "install");
  mkdirSync(install);
  execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", path.join(temp, packed.filename)], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  const cli = path.join(install, "node_modules", "mcptocodemode", "dist", "cli.js");
  const home = path.join(temp, "home");
  mkdirSync(home);
  // Keep tests away from real agent configs, credentials, and caches.
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"), XDG_CONFIG_HOME: path.join(home, ".config"), CODEMODE_CACHE_DIR: path.join(temp, "cache"), NO_COLOR: "1" };
  const run = (args, expected = 0) => {
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], { cwd: temp, env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(expected, 0, `Expected failure for ${args.join(" ")}`);
      return stdout;
    } catch (error) {
      if (error.status !== expected || expected === 0) throw error;
      return String(error.stdout);
    }
  };
  assert.equal(run(["--version"]).trim(), version);
  assert.ok(run(["--help"]).includes("doctor"));
  // Help must not start an MCP server or wait for stdin.
  assert.ok(run(["serve", "--help"]).includes("serve"));
  const demo = JSON.parse(run(["demo", "--json"]));
  assert.equal(demo.correct, true);
  assert.equal(demo.plain.correct, true);
  assert.equal(demo.codeMode.containsBase64, false);
  assert.deepEqual(demo.answer, demo.plain.answer);
  assert.ok(run(["demo"]).includes("Both answers verified"));
  run(["demo", "--unknown"], 1);
  run(["doctor", "--config"], 1);
  const empty = JSON.parse(run(["doctor", "--json"], 1));
  assert.equal(empty.servers, 0);
  const wrapper = path.join(temp, "wrapper.json");
  for (const flags of [[], ["--enable-source-maps"]]) {
    writeFileSync(wrapper, JSON.stringify({ mcpServers: { codemode: { command: process.execPath, args: [...flags, cli, "serve"] } } }));
    assert.equal(JSON.parse(run(["doctor", "--config", wrapper, "--json"], 1)).servers, 0);
  }
  const fixture = path.join(temp, "servers.json");
  const contents = `${JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [cli, "demo-upstream"] } } }, null, 2)}\n`;
  writeFileSync(fixture, contents);
  assert.equal(JSON.parse(run(["doctor", "--config", fixture, "--json"])).ok, true);
  assert.ok(run(["list", "--config", fixture, "--no-cache"]).includes("notes (2)"));

  // A real stdio handshake and all three public tools, not just a CLI fixture.
  const client = new Client({ name: "package-smoke", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", "--config", fixture, "--no-cache"], env, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["describe", "execute", "search"]);
    const search = await client.callTool({ name: "search", arguments: { query: "notes" } });
    assert.ok(JSON.stringify(search).includes("notes"));
    const described = await client.callTool({ name: "describe", arguments: { target: "notes.list" } });
    assert.ok(JSON.stringify(described).includes("notes.list"));
    const execution = await client.callTool({ name: "execute", arguments: { code: "return await notes.list();" } });
    const body = JSON.parse(execution.content.find((block) => block.type === "text").text);
    assert.equal(body.ok, true);
    assert.equal(body.result.length, 2);
  } finally {
    await client.close();
  }
  const broken = path.join(temp, "broken.json");
  writeFileSync(broken, JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: ["-e", "process.exit(2)"] } } }));
  run(["list", "--config", broken, "--no-cache"], 1);
  assert.equal(readFileSync(fixture, "utf8"), contents);
  process.stdout.write(`Installed package smoke passed: Node ${process.version}, demo, doctor, CLI help/version, failed-server exit status, and all three MCP tools.\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
