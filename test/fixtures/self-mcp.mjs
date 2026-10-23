import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Stands in for a nested mcptocodemode: it answers the handshake under that name.
await new McpServer({ name: "mcptocodemode", version: "0" }).connect(new StdioServerTransport());
