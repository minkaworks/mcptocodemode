import { describe, expect, it } from "vitest";
import { measureMail, runDemo } from "../src/demo.js";

describe("offline demo", () => {
  it("checks equal answers and upstream work without exposing the attachment or body", async () => {
    const result = await measureMail();
    expect(result.correct).toBe(true);
    expect(result.plain.correct).toBe(true);
    expect(result.answer).toEqual({ unread: 10, thread: "t21", indexed: { bytes: 150000, mimeType: "image/png" } });
    expect(result.plain.answer).toEqual(result.answer);
    expect(result.plain.calls.map((call) => call.tool)).toEqual([
      "search_threads", "search_threads", "search_threads", "get_message", "get_attachment", "index_attachment",
    ]);
    expect(result.codeMode.upstreamCalls).toBe(result.plain.calls.length);
    expect(result.codeMode.containsBase64).toBe(false);
    expect(result.codeMode.containsBody).toBe(false);
    expect(result.codeMode.envelopeBytes).toBeLessThan(result.plain.resultBytes);
  });

  it("labels its measurement limits and offers parseable JSON", async () => {
    expect(await runDemo()).toContain("Discovery and input bytes are excluded");
    expect(JSON.parse(await runDemo(true))).toMatchObject({ correct: true, plain: { correct: true } });
  });
});
