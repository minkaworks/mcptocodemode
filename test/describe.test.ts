import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogFromServers } from "../src/catalog.js";
import { describeTarget, renderSdk } from "../src/describe.js";

const catalog = catalogFromServers([
  {
    name: "google-calendar",
    tools: [
      {
        name: "list-events",
        description: "List events.",
        inputSchema: { type: "object", required: ["calendarId"], properties: { calendarId: { type: "string" } } },
      },
      { name: "delete", description: "A reserved word.", inputSchema: { type: "object", properties: {} } },
      {
        name: "read",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
      },
    ],
  },
  { name: "notes", tools: [{ name: "get", inputSchema: { type: "object", properties: {} } }] },
]);

// TypeScript 7 has no in-process compiler, so this runs the bundled tsc and keeps
// its syntax errors (codes TS1xxx).
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

function syntaxErrors(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "mcptocodemode-sdk-"));
  try {
    writeFileSync(join(dir, "api.ts"), source);
    const result = spawnSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", "--types", "", "api.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return result.stdout.split("\n").filter((line) => /error TS1\d{3}:/.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


describe("describe", () => {
  it("renders an SDK that TypeScript parses", () => {
    const sdk = renderSdk(catalog);
    expect(syntaxErrors(sdk)).toEqual([]);
    expect(sdk).toContain("declare const google_calendar: {");
    expect(sdk).toContain("list_events(input: {");
    expect(sdk).toContain("resources: {");
    expect(sdk).toContain("delete_(input?:");
  });

  it("types the resolved value from outputSchema and leaves the rest unknown", () => {
    expect(describeTarget(catalog, "google_calendar.read")).toMatch(/Promise<\{\s+content: string;\s+\}>/);
    expect(describeTarget(catalog, "google_calendar.delete")).toContain("Promise<unknown>");
    expect(describeTarget(catalog, "notes.resources.read")).toContain("uri: string;");
    expect(syntaxErrors(renderSdk(catalog))).toEqual([]);
  });

  it("keeps the dotted call form for one method", () => {
    expect(describeTarget(catalog, "google_calendar.list_events")).toContain("google_calendar.list_events(input: {");
    expect(describeTarget(catalog, "notes.prompts.get")).toContain("notes.prompts.get(input: {");
  });
});
