import { describe, expect, it } from "vitest";
import { toIdent, uniqueIdent } from "../src/ident.js";

describe("identifiers", () => {
  it("sanitizes MCP tool names into JavaScript identifiers", () => {
    expect(toIdent("user-Trello-trelloWritePlanner___11")).toBe("user_Trello_trelloWritePlanner_11");
    expect(toIdent("123abc")).toBe("_123abc");
    expect(toIdent("return")).toBe("return_");
  });

  it("suffixes collisions", () => {
    const used = new Set<string>();
    expect(uniqueIdent("search", used)).toBe("search");
    expect(uniqueIdent("search", used)).toBe("search_2");
  });
});
