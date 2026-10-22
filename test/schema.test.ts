import { describe, expect, it } from "vitest";
import { schemaToType } from "../src/schema.js";

describe("schemaToType", () => {
  it("renders objects, enums, unions, and arrays", () => {
    const type = schemaToType({
      type: "object",
      required: ["action", "to"],
      properties: {
        action: { type: "string", enum: ["create_event", "link"], description: "What to do" },
        to: { type: "array", items: { type: "string" }, description: "Recipients" },
        extra: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        "content-type": { type: "string" },
      },
    });

    expect(type).toContain("action: \"create_event\" | \"link\";");
    expect(type).toContain("to: string[];");
    expect(type).toContain("extra?: string | string[];");
    expect(type).toContain('"content-type"?: string;');
    expect(type).toContain("/** What to do */");
  });

  it("renders an empty closed object as {}", () => {
    expect(schemaToType({ type: "object", properties: {}, additionalProperties: false })).toBe("{}");
  });
});
