import { describe, expect, it } from "vitest";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import { readOnlyPolicy } from "../src/policy.js";

const empty = { type: "object", properties: {} } as const;

function mode(allow?: string[]) {
  const catalog = catalogFromServers([
    {
      name: "files",
      tools: [
        { name: "read_file", inputSchema: empty, annotations: { readOnlyHint: true } },
        { name: "delete_file", inputSchema: empty, annotations: { destructiveHint: true } },
        { name: "touch", inputSchema: empty },
      ],
    },
  ]);
  const ran: string[] = [];
  const runtime = new CodeMode(
    catalog,
    async (call) => {
      ran.push(call.method);
      return "done";
    },
    { beforeCall: readOnlyPolicy(catalog, { allow }) },
  );
  return { runtime, ran };
}

describe("read-only policy", () => {
  it("runs read-only methods and protocol reads, and refuses the rest before they reach the server", async () => {
    const { runtime, ran } = mode();
    expect(await runtime.execute(`return await files.read_file();`)).toMatchObject({ ok: true });
    expect(await runtime.execute(`return await files.resources.list();`)).toMatchObject({ ok: true });
    const destructive = await runtime.execute(`return await files.delete_file();`);
    expect(destructive.ok).toBe(false);
    expect(destructive.error).toContain("files.delete_file is not marked read-only");
    expect(destructive.error).toContain("--allow files.delete_file");
    expect((await runtime.execute(`return await files.touch();`)).ok).toBe(false);
    expect(ran).toEqual(["read_file", "resources.list"]);
    runtime.close();
  });

  it("allows named exceptions by method or by server", async () => {
    const one = mode(["files.touch"]);
    expect(await one.runtime.execute(`return await files.touch();`)).toMatchObject({ ok: true });
    expect((await one.runtime.execute(`return await files.delete_file();`)).ok).toBe(false);
    one.runtime.close();

    const all = mode(["files.*"]);
    expect(await all.runtime.execute(`return await files.delete_file();`)).toMatchObject({ ok: true });
    all.runtime.close();
  });
});
