import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnose, formatDiagnosis } from "../src/doctor.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(value: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "codemode-doctor-"));
  roots.push(root);
  const file = path.join(root, "mcp.json");
  const text = JSON.stringify(value);
  await writeFile(file, text);
  return { root, file, text };
}

describe("configuration diagnosis", () => {
  it("checks local and remote configs without executing, contacting, writing, or leaking values", async () => {
    const { root, file, text } = await fixture({ mcpServers: {
      local: { command: process.execPath, args: ["-e", "process.exit(123)", "private-argument"], env: { TOKEN: "private-env" } },
      remote: { url: "https://private-url.invalid/mcp?token=private-query", headers: { Authorization: "Bearer private-header" } },
      codemode: { command: "npx", args: ["-y", "mcptocodemode", "serve"] },
    } });
    const report = await diagnose({ configs: [file], cwd: root, env: {} });
    expect(report.ok).toBe(true);
    expect(report.servers).toBe(2);
    expect(report.checks.map((check) => check.status)).toEqual(["ok", "ok"]);
    const output = JSON.stringify(report) + formatDiagnosis(report);
    for (const hidden of ["private-argument", "private-env", "private-url", "private-query", "private-header"]) expect(output).not.toContain(hidden);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readdir(root)).toEqual(["mcp.json"]);
  });

  it("identifies missing variables across formats, with defaults and supplied values accepted", async () => {
    const { root, file } = await fixture({ mcpServers: {
      broken: { url: "https://example.com/mcp", headers: { A: "Bearer ${TOKEN}", B: "{env:OTHER}" } },
      good: { url: "https://example.com/mcp", headers: { A: "${SUPPLIED}", B: "${OPTIONAL:-fallback}" } },
    } });
    const report = await diagnose({ configs: [file], cwd: root, env: { SUPPLIED: "private-value" } });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === "error")).toEqual([
      { status: "error", target: "broken", message: expect.stringContaining("OTHER, TOKEN") },
    ]);
    expect(JSON.stringify(report)).not.toContain("private-value");
  });

  it("reports missing executables, directories, invalid URLs and unsupported schemes", async () => {
    const { root, file } = await fixture({ mcpServers: {
      missing: { command: "not-installed" },
      cwd: { command: process.execPath, cwd: "missing-dir" },
      invalid: { url: "not-a-url" },
      scheme: { url: "file:///private/path" },
    } });
    const report = await diagnose({ configs: [file], cwd: root, env: { PATH: "" } });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === "error").map((check) => check.target)).toEqual(["missing", "cwd", "invalid", "scheme"]);
  });

  it("uses server PATH and cwd, and refuses a directory in place of a command", async () => {
    const { root, file } = await fixture({ mcpServers: {
      good: { command: "fixture-command", env: { PATH: "bin" } },
      directory: { command: "./bin" },
      pathDirectory: { command: "folder-command", env: { PATH: "bin" } },
    } });
    await mkdir(path.join(root, "bin"));
    await mkdir(path.join(root, "bin", "folder-command"));
    const executable = path.join(root, "bin", "fixture-command");
    await writeFile(executable, "This file must never run.");
    await chmod(executable, 0o755);
    const report = await diagnose({ configs: [file], cwd: root, env: { PATH: "" } });
    expect(report.checks).toMatchObject([{ status: "ok", target: "good" }, { status: "error", target: "directory" }, { status: "error", target: "pathDirectory" }]);
  });

  it("withholds parser excerpts and unreadable file errors", async () => {
    const { root, file } = await fixture({});
    await writeFile(file, '{"token": "private-parser-secret", BROKEN}');
    const report = await diagnose({ configs: [file, path.join(root, "absent.json")], env: {} });
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.message.includes("Cannot read"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private-parser-secret");
  });

  it("identifies a malformed discovered file without exposing parser excerpts", async () => {
    const { root, file } = await fixture({ mcpServers: { good: { command: process.execPath } } });
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const invalid = path.join(home, ".codex", "config.toml");
    await writeFile(invalid, '[mcp_servers.bad]\ncommand = "private-parser-secret"\nBROKEN');
    const report = await diagnose({ configs: undefined, cwd: root, home, env: {} });
    expect(report.ok).toBe(false);
    expect(report.files).toEqual(expect.arrayContaining([file, invalid]));
    expect(report.checks).toContainEqual({ status: "error", target: invalid, message: expect.stringContaining("parser excerpts are withheld") });
    const output = JSON.stringify(report) + formatDiagnosis(report);
    expect(output).toContain(invalid);
    expect(output).not.toContain("private-parser-secret");
  });

  it.skipIf(process.platform === "win32")("uses the POSIX spawn default only when PATH is absent", async () => {
    const { root, file } = await fixture({ mcpServers: { shell: { command: "sh" } } });
    const absent = await diagnose({ configs: [file], cwd: root, env: {} });
    expect(absent.ok).toBe(true);
    const empty = await diagnose({ configs: [file], cwd: root, env: { PATH: "" } });
    expect(empty.ok).toBe(false);
  });

  it("does not count this package's source-style serve entry as an upstream", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { root, file } = await fixture({ mcpServers: { codemode: { command: process.execPath, args: [cli, "serve"] } } });
    const report = await diagnose({ configs: [file], cwd: root, env: {} });
    expect(report.ok).toBe(false);
    expect(report.servers).toBe(0);
    expect(report.checks[0]?.message).toContain("No upstream MCP servers");
    await writeFile(file, JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [cli, "demo-upstream"] } } }));
    expect((await diagnose({ configs: [file], cwd: root, env: {} })).servers).toBe(1);
    const other = path.join(root, "cli.js");
    await writeFile(other, "This is an unrelated server, not Code Mode.");
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: process.execPath, args: [other, "serve"] } } }));
    expect((await diagnose({ configs: [file], cwd: root, env: {} })).servers).toBe(1);
  });

  it("recognizes own Node launches after common flags without hiding inline or unrelated programs", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { root, file } = await fixture({});
    const options = [
      ["--enable-source-maps"],
      ["--no-warnings", "--enable-source-maps"],
      ["--inspect=0"],
      ["--require", "./preload.cjs"],
      ["--import=./preload.mjs"],
      ["--"],
    ];
    for (const flags of options) {
      await writeFile(file, JSON.stringify({ mcpServers: { self: { command: process.execPath, args: [...flags, cli, "serve"] } } }));
      expect((await diagnose({ configs: [file], cwd: root, env: {} })).servers, flags.join(" ")).toBe(0);
    }
    for (const flags of [["--eval", "someInlineProgram"], ["--title"], ["--unknown-option"]]) {
      await writeFile(file, JSON.stringify({ mcpServers: { other: { command: process.execPath, args: [...flags, cli, "serve"] } } }));
      expect((await diagnose({ configs: [file], cwd: root, env: {} })).servers, flags.join(" ")).toBe(1);
    }
  });

  it("discovers configs with the same precedence as serve and handles an empty machine", async () => {
    const { root } = await fixture({});
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await mkdir(project);
    await writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { same: { command: "missing" } } }));
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { same: { command: process.execPath } } }));
    const report = await diagnose({ cwd: project, home, env: {} });
    expect(report.ok).toBe(true);
    expect(report.servers).toBe(1);
    await rm(path.join(home, ".cursor", "mcp.json"));
    await rm(path.join(project, ".mcp.json"));
    const empty = await diagnose({ cwd: project, home, env: {} });
    expect(empty.ok).toBe(false);
    expect(empty.checks[0]?.message).toContain("No upstream MCP servers");
  });
});
