import { describe, expect, it } from "vitest";
import { BlobStore } from "../src/blobs.js";
import { catalogFromServers } from "../src/catalog.js";
import { CodeMode } from "../src/codemode.js";
import type { ToolCall } from "../src/types.js";
import { slimContents, valueFromToolResult } from "../src/upstream.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 7)]).toString("base64");

describe("blob handles", () => {
  it("keeps image bytes in the host and hands them to the next tool", async () => {
    const received: unknown[] = [];
    const catalog = catalogFromServers([
      {
        name: "mail",
        tools: [
          { name: "get_attachment", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
          { name: "index_attachment", inputSchema: { type: "object", properties: { file: { type: "string" } } } },
        ],
      },
    ]);
    const mode: CodeMode = new CodeMode(catalog, async (call: ToolCall) => {
      if (call.method === "get_attachment") {
        return valueFromToolResult({ content: [{ type: "image", data: png, mimeType: "image/png" }] }, 200_000, mode.blobs);
      }
      received.push(call.input.file);
      return { bytes: Buffer.from(String(call.input.file), "base64").length };
    });

    const peek = await mode.execute(`state.att = await mail.get_attachment({ id: "a1" }); return state.att;`);
    expect(peek.ok).toBe(true);
    expect(peek.result).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(typeof (peek.result as { $handle: string }).$handle).toBe("string");
    expect(JSON.stringify(peek)).not.toContain(png.slice(0, 40));

    const indexed = await mode.execute(`console.log(state.att); return await mail.index_attachment({ file: state.att });`);
    expect(indexed).toMatchObject({ ok: true, result: { bytes: 3004 } });
    expect(received).toEqual([png]);
    expect(JSON.stringify(indexed)).not.toContain(png.slice(0, 40));

    const unknown = await mode.execute(`return await mail.index_attachment({ file: { $handle: "blob_nope" } });`);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('Unknown handle "blob_nope"');
    expect(received).toHaveLength(1);

    await mode.execute(`return null;`, { reset: true });
    expect(mode.blobs.size).toBe(0);
    mode.close();
  });

  it("falls back to omitted past the caps, with no store, or with structuredContent", () => {
    const small = new BlobStore({ maxBlobBytes: 1000, maxTotalBytes: 5000 });
    expect(valueFromToolResult({ content: [{ type: "image", data: png, mimeType: "image/png" }] }, 200_000, small)).toEqual({
      type: "image",
      mimeType: "image/png",
      omitted: true,
    });
    expect(valueFromToolResult({ content: [{ type: "audio", data: png, mimeType: "audio/wav" }] }, 200_000)).toMatchObject({
      omitted: true,
    });
    const structured = valueFromToolResult(
      { structuredContent: { ok: true }, content: [{ type: "image", data: png, mimeType: "image/png" }] },
      200_000,
      new BlobStore(),
    );
    expect(structured).toEqual({ ok: true });

    const capped = new BlobStore({ maxBlobBytes: 4000, maxTotalBytes: 5000 });
    expect(capped.put(png, "image", "image/png")).toBeDefined();
    expect(capped.put(png, "image", "image/png")).toBeUndefined();
  });

  it("turns a resource blob into a handle under blob", () => {
    const store = new BlobStore();
    const value = slimContents([{ uri: "file:///a.png", mimeType: "image/png", blob: png }], store) as {
      uri: string;
      blob: { $handle: string };
    };
    expect(value.uri).toBe("file:///a.png");
    expect(store.get(value.blob.$handle)?.data).toBe(png);
    expect(store.expand({ nested: [{ $handle: value.blob.$handle, type: "blob" }] })).toEqual({ nested: [png] });
    expect(store.expand({ $handle: value.blob.$handle, uri: "kept" })).toEqual({ $handle: value.blob.$handle, uri: "kept" });
  });
});
