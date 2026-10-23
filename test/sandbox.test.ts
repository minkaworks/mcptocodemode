import { describe, expect, it } from "vitest";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import type { ToolCall } from "../src/types.js";

const notes = [
  { id: "1", title: "Buy milk", body: "Whole milk." },
  { id: "2", title: "Ship codemode", body: "Three tools." },
];

function mode() {
  const catalog = catalogFromServers([
    {
      name: "notes",
      tools: [
        {
          name: "list",
          description: "List notes.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "get",
          description: "Read one note.",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      ],
    },
  ]);
  return new CodeMode(catalog, async (call: ToolCall) => {
    if (call.method === "list") return notes.map(({ id, title }) => ({ id, title }));
    if (call.method === "get") {
      const note = notes.find((item) => item.id === call.input.id);
      if (!note) throw new Error(`No note ${String(call.input.id)}`);
      return note;
    }
    throw new Error(`Unknown ${call.method}`);
  });
}

describe("sandbox", () => {
  it("composes several tool calls and returns only the final value", async () => {
    const result = await mode().execute(`
      const rows = await notes.list();
      const full = [];
      for (const row of rows) full.push(await notes.get({ id: row.id }));
      console.log("loaded", full.length);
      return full.map((note) => note.body);
    `);

    expect(result.ok).toBe(true);
    expect(result.result).toEqual(["Whole milk.", "Three tools."]);
    expect(result.logs).toEqual(["loaded 2"]);
    // A run where everything succeeded reports one entry per method.
    expect(result.calls.map(({ method, ...rest }) => ({ method, count: "count" in rest ? rest.count : 0 }))).toEqual([
      { method: "list", count: 1 },
      { method: "get", count: 2 },
    ]);
    expect(result.calls.every((call) => !("input" in call))).toBe(true);
  });

  it("runs tool calls concurrently", async () => {
    const result = await mode().execute(`
      const [a, b] = await Promise.all([notes.get({ id: "1" }), notes.get({ id: "2" })]);
      return [a.title, b.title];
    `);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual(["Buy milk", "Ship codemode"]);
  });

  it("can search and describe without leaving the sandbox", async () => {
    const result = await mode().execute(`
      const found = await codemode.search("read one note");
      const signature = await codemode.describe("notes.get");
      return { method: found.hits[0].method, hasId: signature.includes("id") };
    `);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ method: "get", hasId: true });
  });

  it("has no host process, fetch, or require", async () => {
    const result = await mode().execute(`return [typeof process, typeof fetch, typeof require].join(":");`);
    expect(result.ok).toBe(true);
    expect(result.result).toBe("undefined:undefined:undefined");
  });

  it("returns a tool error to the guest", async () => {
    const result = await mode().execute(`return await notes.get({ id: "missing" });`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No note missing");
    // A failed run keeps one entry per call.
    expect(result.calls[0]).toMatchObject({ method: "get", ok: false });
  });

  it("stops a tight loop at the deadline", async () => {
    const result = await mode().execute(`while (true) {}`, { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("stops after the call budget", async () => {
    const runtime = new CodeMode(mode().catalog, async () => [], { limits: { maxCalls: 2 } });
    const result = await runtime.execute(`
      await notes.list();
      await notes.list();
      await notes.list();
      return "nope";
    `);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2 tool calls");
  });

  it("lets a policy reject a call before it runs", async () => {
    let ran = false;
    const runtime = new CodeMode(mode().catalog, async () => {
      ran = true;
      return [];
    }, {
      beforeCall: (call) => {
        if (call.method === "list") throw new Error("list is blocked");
      },
    });
    const result = await runtime.execute(`return await notes.list();`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("list is blocked");
    expect(ran).toBe(false);
  });

  it("accepts an IIFE, a bare expression, and a body that starts with a parenthesis", async () => {
    const runtime = mode();
    const iife = await runtime.execute(`(async () => (await notes.list()).length)()`);
    expect(iife).toMatchObject({ ok: true, result: 2 });
    const expression = await runtime.execute(`(await notes.list()).length`);
    expect(expression).toMatchObject({ ok: true, result: 2 });
    const body = await runtime.execute(`(await notes.list()).forEach(() => {});\nreturn "body";`);
    expect(body).toMatchObject({ ok: true, result: "body" });
  });

  it("survives a run that ends while a call is still in flight", async () => {
    const slow = new CodeMode(mode().catalog, () => new Promise((resolve) => setTimeout(() => resolve([]), 50)));
    const unawaited = await slow.execute(`notes.list(); return 1;`);
    expect(unawaited).toMatchObject({ ok: true, result: 1 });
    const thrown = await slow.execute(`notes.list(); throw new Error("boom");`);
    expect(thrown).toMatchObject({ ok: false, error: "Error: boom" });
    const timedOut = await slow.execute(`await notes.list(); while (true) {}`, { timeoutMs: 20 });
    expect(timedOut.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await slow.execute(`return "still alive";`)).toMatchObject({ ok: true, result: "still alive" });
  });
});

describe("session", () => {
  it("keeps state across runs but not let or const", async () => {
    const runtime = mode();
    expect(await runtime.execute(`state.n = 1; let local = 5; globalThis.seen = true; return state.n;`)).toMatchObject({ ok: true, result: 1 });
    expect(await runtime.execute(`state.n += 1; return [state.n, typeof local, seen];`)).toMatchObject({
      ok: true,
      result: [2, "undefined", true],
    });
    runtime.close();
  });

  it("starts empty after reset", async () => {
    const runtime = mode();
    await runtime.execute(`state.n = 1; return null;`);
    expect(await runtime.execute(`return state.n ?? "empty";`, { reset: true })).toMatchObject({ ok: true, result: "empty" });
    runtime.close();
  });

  it("clears the session after a timeout", async () => {
    const runtime = mode();
    await runtime.execute(`state.n = 1; return null;`);
    const timedOut = await runtime.execute(`while (true) {}`, { timeoutMs: 100 });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe("Execution timed out. The session was cleared.");
    expect(await runtime.execute(`return state.n ?? "empty";`)).toMatchObject({ ok: true, result: "empty" });
    runtime.close();
  });

  it("refuses a second execute while one is running", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new CodeMode(mode().catalog, async () => {
      await gate;
      return [];
    });
    const first = runtime.execute(`state.ran = true; return await notes.list();`);
    const second = await runtime.execute(`state.ran = "second"; return 2;`);
    expect(second).toEqual({ ok: false, error: "Another execute is still running.", logs: [], calls: [] });
    release();
    expect(await first).toMatchObject({ ok: true, result: [] });
    expect(await runtime.execute(`return state.ran;`)).toMatchObject({ ok: true, result: true });
    runtime.close();
  });

  it("binds a server that joined the catalog after the first run", async () => {
    const runtime = mode();
    expect(await runtime.execute(`return typeof calendar;`)).toMatchObject({ result: "undefined" });
    runtime.catalog.servers.push(
      ...catalogFromServers([{ name: "calendar", tools: [{ name: "today", inputSchema: { type: "object", properties: {} } }] }]).servers,
    );
    expect(await runtime.execute(`return [typeof calendar.today, typeof notes.get];`)).toMatchObject({
      result: ["function", "function"],
    });
    runtime.close();
  });
});
