import { describe, expect, it } from "vitest";
import { toIdent, uniqueIdent, uniqueMethodIdent } from "../src/ident.js";

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

  it("keeps reserved words as method names, since methods are properties", () => {
    const used = new Set<string>(["resources", "prompts"]);
    expect(uniqueMethodIdent("delete", used)).toBe("delete");
    expect(uniqueMethodIdent("new", used)).toBe("new");
    expect(uniqueMethodIdent("constructor", used)).toBe("constructor_");
    expect(uniqueMethodIdent("resources", used)).toBe("resources_2");
  });
});
