import { findServer, findTool } from "./catalog.js";
import type { Catalog, ToolCall } from "./types.js";

export type ReadOnlyOptions = {
  /** `server.method` or `server.*`, by ident or config name, allowed even when not marked read-only. */
  allow?: string[];
};

/**
 * A `beforeCall` that refuses any method its server does not mark
 * `readOnlyHint: true`. Resources and prompts are read-only. The hint comes
 * from the upstream server, so this is as trustworthy as that server.
 */
export function readOnlyPolicy(catalog: Catalog, options: ReadOnlyOptions = {}): (call: ToolCall) => void {
  const allow = new Set(options.allow ?? []);
  return (call) => {
    const server = findServer(catalog, call.server);
    const tool = server && findTool(server, call.method);
    if (tool?.annotations?.readOnlyHint === true) return;
    const names = server ? [server.ident, server.name] : [call.server];
    if (names.some((name) => allow.has(`${name}.${call.method}`) || allow.has(`${name}.*`))) return;
    const target = `${server?.ident ?? call.server}.${call.method}`;
    throw new Error(
      `${target} is not marked read-only by its server, and this mcptocodemode runs with --read-only. Start it with --allow ${target} to permit it.`,
    );
  };
}
