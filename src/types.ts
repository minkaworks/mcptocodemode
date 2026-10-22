/** JSON Schema subset that MCP tool inputs actually use. */
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

export type ListedTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

export type ToolRecord = {
  /** Config name of the upstream server. */
  server: string;
  /** Global the sandbox exposes for that server. */
  serverIdent: string;
  /** Tool name as the upstream server reports it. Protocol methods use the method path. */
  name: string;
  /** Method name on the server global. Dotted for resources.* and prompts.*. */
  method: string;
  description: string;
  inputSchema: JsonSchema;
  /** Protocol methods are resources and prompts. They are present on every connected server. */
  kind?: "tool" | "protocol";
};

export type ServerNamespace = {
  name: string;
  ident: string;
  tools: ToolRecord[];
  /** Set when this server was configured but did not connect. Other servers still load. */
  error?: string;
};

export type Catalog = {
  servers: ServerNamespace[];
};

export type ToolCall = {
  server: string;
  method: string;
  tool: string;
  input: Record<string, unknown>;
};

export type Dispatcher = (call: ToolCall) => Promise<unknown>;

export type CallTrace = {
  server: string;
  method: string;
  ok: boolean;
  ms: number;
};

export type ExecuteResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  calls: CallTrace[];
};

export type SearchHit = {
  server: string;
  method: string;
  tool: string;
  description: string;
  required: string[];
  score: number;
};

export type Limits = {
  timeoutMs: number;
  memoryBytes: number;
  maxCalls: number;
  maxCodeChars: number;
  maxResultChars: number;
};

export const defaultLimits: Limits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 100,
  maxCodeChars: 100_000,
  maxResultChars: 200_000,
};

export const PROTOCOL_VERSION = "0.1";
