import { describe, expect, it } from "vitest";
import { catalogFromFlatTools } from "../src/catalog.js";
import { describeTarget } from "../src/describe.js";
import { searchCatalog } from "../src/search.js";

const catalog = catalogFromFlatTools([
  {
    name: "gmail__search",
    description: "Search for relevant emails in the user's connected Gmail account.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "Gmail search query" } },
    },
  },
  {
    name: "gmail__list_labels",
    description: "List all Gmail labels.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "google_calendar__search",
    description: "Search for events in Google Calendar.",
    inputSchema: {
      type: "object",
      properties: { time_min: { type: "string" }, time_max: { type: "string" } },
    },
  },
  {
    name: "cursor__user-Trello-trelloReadCard",
    description: "Read a Trello card.",
    inputSchema: { type: "object", required: ["cardId"], properties: { cardId: { type: "string" } } },
  },
]);

describe("search and describe", () => {
  it("keeps the full catalog out of a search hit", () => {
    const found = searchCatalog(catalog, "unread email");
    expect(found.servers.map((server) => server.ident)).toEqual(["gmail", "google_calendar", "cursor"]);
    expect(found.hits[0]?.method).toBe("search");
    expect(found.hits[0]?.server).toBe("gmail");
    expect(found.hits[0]?.required).toEqual(["query"]);
    expect(JSON.stringify(found.hits[0])).not.toContain("inputSchema");
  });

  it("describes one method as TypeScript", () => {
    const typescript = describeTarget(catalog, "gmail.search");
    expect(typescript).toContain("gmail.search(input:");
    expect(typescript).toContain("query: string");
    expect(typescript).toContain("Promise<unknown>");
  });

  it("describes a sanitized cursor method", () => {
    const typescript = describeTarget(catalog, "cursor.user_Trello_trelloReadCard");
    expect(typescript).toContain("cardId: string");
  });
});
