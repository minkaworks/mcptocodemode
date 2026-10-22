import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodeMode, createCodeModeServer, loadConfig, UpstreamPool } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fsRoot = process.env.CODEMODE_FS_ROOT ?? "/tmp/mcptocodemode-demo";
const memoryFile = process.env.CODEMODE_MEMORY_FILE ?? path.join(fsRoot, "memory.jsonl");
const gitRepo = process.env.CODEMODE_GIT_REPO ?? "/tmp/mcptocodemode-demo-repo";
process.env.CODEMODE_FS_ROOT = fsRoot;
process.env.CODEMODE_MEMORY_FILE = memoryFile;
process.env.CODEMODE_GIT_REPO = gitRepo;

const helloPath = path.join(fsRoot, "hello.txt");
const logPath = path.join(fsRoot, "service.log");
const ordersDir = path.join(fsRoot, "orders");
const logLines = 2_000;
const orderCount = 25;
const runs = 3;
const pageUrl = "https://github.com/modelcontextprotocol/servers";

prepareFixtures();

const config = await loadConfig(path.join(root, "mcptocodemode.reference.example.json"));
process.stderr.write("connecting\n");
const pool = await UpstreamPool.connect(config.servers);
const mode = new CodeMode(pool.catalog, (call) => pool.call(call, config.limits.maxResultChars), {
  limits: config.limits,
});

try {
  const report = {
    at: new Date().toISOString(),
    node: process.version,
    protocol: "0.1",
    servers: pool.catalog.servers.map((server) => ({
      name: server.name,
      ident: server.ident,
      tools: server.tools.filter((tool) => tool.kind !== "protocol").length,
      error: server.error ?? null,
    })),
    prompt: {},
    discovery: {},
    task: { direct: [], code: [] },
    scaling: [],
    tasks: {},
  };

  report.prompt.flat = toolBytes(flatTools(pool.catalog));
  const codeModeList = await codeModeTools(mode);
  report.prompt.codeMode = toolBytes(codeModeList);
  const executeTool = codeModeList.find((tool) => tool.name === "execute");
  const sdk = mode.sdk();
  report.prompt.inlineSdk = {
    tools: 1,
    sdkBytes: Buffer.byteLength(sdk),
    executeToolBytes: executeTool ? jsonBytes(executeTool) : 0,
  };
  report.prompt.inlineSdk.bytes = report.prompt.inlineSdk.sdkBytes + report.prompt.inlineSdk.executeToolBytes;

  const searchAll = mode.search("", { limit: 8 });
  report.discovery.emptySearch = { bytes: jsonBytes(searchAll), hits: searchAll.hits.length };
  const methodTargets = [
    "time.get_current_time",
    "filesystem.read_text_file",
    "git.git_log",
    "sequential_thinking.sequentialthinking",
    "memory.create_entities",
    "memory.read_graph",
    "fetch.fetch",
    "everything.echo",
  ];
  const described = methodTargets.map((target) => mode.describe(target));
  report.discovery.usedMethods = {
    count: described.length,
    bytes: described.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
  const serverDocs = pool.catalog.servers.filter((server) => !server.error).map((server) => mode.describe(server.ident));
  report.discovery.everyServer = {
    count: serverDocs.length,
    bytes: serverDocs.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };

  report.scaling = scaling(pool.catalog, report.prompt.codeMode.bytes, report.prompt.inlineSdk.executeToolBytes);
  report.tasks.bigFile = await compare(pool, mode, bigFileTask(), config.limits.maxResultChars);
  report.tasks.fanOut = await compare(pool, mode, fanOutTask(), config.limits.maxResultChars);

  const task = buildTask(helloPath, gitRepo);
  for (let i = 0; i < runs; i += 1) {
    process.stderr.write(`direct ${i + 1}\n`);
    report.task.direct.push(await timeDirect(pool, task, config.limits.maxResultChars));
    process.stderr.write(`code ${i + 1}\n`);
    report.task.code.push(await timeCode(mode, task.code));
  }

  const out = path.join(root, "experiments", "reference-servers.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await pool.close();
}

function prepareFixtures() {
  mkdirSync(fsRoot, { recursive: true });
  writeFileSync(helloPath, "hello from the filesystem server\n");
  writeFileSync(logPath, serviceLog());
  mkdirSync(ordersDir, { recursive: true });
  for (let i = 1; i <= orderCount; i += 1) {
    const order = {
      id: `ord-${String(i).padStart(3, "0")}`,
      customer: `customer-${(i * 7) % 11}`,
      status: i % 4 === 0 ? "refunded" : "paid",
      total: Math.round(((i * 37) % 200) * 100 + 999) / 100,
      lines: Array.from({ length: 3 + (i % 4) }, (_, n) => ({ sku: `sku-${(i + n) % 13}`, qty: 1 + ((i + n) % 3) })),
      note: "Deterministic fixture written by scripts/measure.mjs.",
    };
    writeFileSync(path.join(ordersDir, `${order.id}.json`), `${JSON.stringify(order, null, 2)}\n`);
  }
  mkdirSync(path.dirname(memoryFile), { recursive: true });
  if (existsSync(path.join(gitRepo, ".git"))) return;
  mkdirSync(gitRepo, { recursive: true });
  execSync("git init -q", { cwd: gitRepo });
  execSync("git config user.email demo@example.com", { cwd: gitRepo });
  execSync("git config user.name demo", { cwd: gitRepo });
  writeFileSync(path.join(gitRepo, "README.md"), "hello from the official git server\n");
  execSync("git add README.md && git commit -q -m demo", { cwd: gitRepo });
}

/** A deterministic log: mostly INFO, an ERROR every 97 lines. */
function serviceLog() {
  const lines = [];
  for (let i = 1; i <= logLines; i += 1) {
    const at = new Date(Date.UTC(2026, 9, 22, 9, 0, i)).toISOString();
    if (i % 97 === 0) lines.push(`${at} ERROR payment-worker job=${i} upstream timed out after 30000 ms`);
    else lines.push(`${at} INFO  http GET /api/orders/${i % 50} 200 ${(i * 13) % 90 + 4}ms`);
  }
  return `${lines.join("\n")}\n`;
}

/** Prompt bytes as servers are added one at a time, in config order. */
function scaling(catalog, codeModeBytes, executeToolBytes) {
  const rows = [];
  const connected = catalog.servers.filter((server) => !server.error);
  for (let n = 1; n <= connected.length; n += 1) {
    const subset = { servers: connected.slice(0, n) };
    const flat = toolBytes(flatTools(subset));
    const sdkBytes = connected
      .slice(0, n)
      .reduce((sum, server) => sum + Buffer.byteLength(mode.describe(server.ident)), 0);
    rows.push({
      servers: n,
      added: connected[n - 1].name,
      tools: flat.tools,
      flat: flat.bytes,
      inlineSdk: sdkBytes + executeToolBytes,
      codeMode: codeModeBytes,
    });
  }
  return rows;
}

/** Read one 2,000-line log. The model wants the ERROR count and the last three. */
function bigFileTask() {
  return {
    name: "Count ERROR lines in a 2,000-line log and return the last three",
    direct: [{ server: "filesystem", method: "read_text_file", tool: "read_text_file", input: { path: logPath } }],
    code: [
      `const file = await filesystem.read_text_file({ path: ${JSON.stringify(logPath)} });`,
      `const errors = String(file.content ?? file).split("\\n").filter((line) => line.includes(" ERROR "));`,
      `return { count: errors.length, last: errors.slice(-3) };`,
    ].join("\n"),
  };
}

/** List a directory, read every order, and total the paid ones. */
function fanOutTask() {
  const direct = [{ server: "filesystem", method: "list_directory", tool: "list_directory", input: { path: ordersDir } }];
  for (let i = 1; i <= orderCount; i += 1) {
    const file = path.join(ordersDir, `ord-${String(i).padStart(3, "0")}.json`);
    direct.push({ server: "filesystem", method: "read_text_file", tool: "read_text_file", input: { path: file } });
  }
  return {
    name: `Read ${orderCount} order files and total the paid ones`,
    direct,
    code: [
      `const listing = await filesystem.list_directory({ path: ${JSON.stringify(ordersDir)} });`,
      `const names = String(listing.content ?? listing).split("\\n").map((line) => line.replace("[FILE] ", "").trim()).filter((name) => name.endsWith(".json"));`,
      `const orders = await Promise.all(names.map(async (name) => {`,
      `  const file = await filesystem.read_text_file({ path: ${JSON.stringify(ordersDir)} + "/" + name });`,
      `  return JSON.parse(String(file.content ?? file));`,
      `}));`,
      `const paid = orders.filter((order) => order.status === "paid");`,
      `return { orders: orders.length, paid: paid.length, total: Math.round(paid.reduce((sum, order) => sum + order.total, 0) * 100) / 100 };`,
    ].join("\n"),
  };
}

/**
 * Run a task both ways. Flat: every call is a model turn and its result enters
 * the conversation; each later turn re-reads the earlier ones. Code Mode: one
 * execute, and only its envelope comes back.
 */
async function compare(pool, mode, task, maxResultChars) {
  const flatResults = [];
  const started = performance.now();
  for (const call of task.direct) {
    const value = await pool.call(call, maxResultChars);
    flatResults.push(jsonBytes(value));
  }
  const flatMs = elapsed(started);
  let running = 0;
  let reread = 0;
  for (const bytes of flatResults) {
    running += bytes;
    reread += running;
  }
  const codeStarted = performance.now();
  const result = await mode.execute(task.code);
  const codeMs = elapsed(codeStarted);
  if (!result.ok) throw new Error(`${task.name}: ${result.error}`);
  const envelope = jsonBytes({ ok: result.ok, result: result.result, logs: result.logs, calls: result.calls });
  return {
    name: task.name,
    flat: { turns: task.direct.length, resultBytes: running, rereadBytes: reread, ms: flatMs },
    codeMode: {
      turns: 1,
      codeBytes: Buffer.byteLength(task.code),
      envelopeBytes: envelope,
      answerBytes: jsonBytes(result.result),
      upstreamCalls: result.calls.length,
      ms: codeMs,
    },
    answer: result.result,
  };
}

function flatTools(catalog) {
  const tools = [];
  for (const server of catalog.servers) {
    for (const tool of server.tools) {
      if (tool.kind === "protocol") continue;
      tools.push({
        name: `${server.ident}__${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return tools;
}

async function codeModeTools(mode) {
  const mcp = createCodeModeServer(mode);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure", version: "0" });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
  } finally {
    await client.close();
    await mcp.close();
  }
}

function toolBytes(tools) {
  return {
    tools: tools.length,
    bytes: tools.reduce((sum, tool) => sum + jsonBytes(tool), 0),
    largest: tools
      .map((tool) => ({ name: tool.name, bytes: jsonBytes(tool) }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5),
  };
}

function buildTask(hello, repo) {
  const calls = [
    { server: "time", method: "get_current_time", tool: "get_current_time", input: { timezone: "America/Mexico_City" } },
    { server: "filesystem", method: "read_text_file", tool: "read_text_file", input: { path: hello } },
    { server: "git", method: "git_log", tool: "git_log", input: { repo_path: repo, max_count: 2 } },
    {
      server: "sequential_thinking",
      method: "sequentialthinking",
      tool: "sequentialthinking",
      input: {
        thought: "Compare the protocols on one task.",
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
      },
    },
    {
      server: "memory",
      method: "create_entities",
      tool: "create_entities",
      input: {
        entities: [{ name: "MCPtoCodeMode", entityType: "project", observations: ["Measured against flat MCP."] }],
      },
    },
    { server: "memory", method: "read_graph", tool: "read_graph", input: {} },
    { server: "fetch", method: "fetch", tool: "fetch", input: { url: pageUrl } },
    { server: "everything", method: "echo", tool: "echo", input: { message: "hello from codemode" } },
  ];
  const code = [
    `const clock = await time.get_current_time({ timezone: "America/Mexico_City" });`,
    `const file = await filesystem.read_text_file({ path: ${JSON.stringify(hello)} });`,
    `const log = await git.git_log({ repo_path: ${JSON.stringify(repo)}, max_count: 2 });`,
    `const thought = await sequential_thinking.sequentialthinking({ thought: "Compare the protocols on one task.", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 });`,
    `await memory.create_entities({ entities: [{ name: "MCPtoCodeMode", entityType: "project", observations: ["Measured against flat MCP."] }] });`,
    `const graph = await memory.read_graph();`,
    `const page = await fetch.fetch({ url: ${JSON.stringify(pageUrl)} });`,
    `const echoed = await everything.echo({ message: "hello from codemode" });`,
    `const logText = typeof log === "string" ? log : JSON.stringify(log);`,
    `return { datetime: clock.datetime, file: file.content, commitLine: logText.split("\\n")[0], thoughts: thought.thoughtHistoryLength, memory: graph.entities.map((entity) => entity.name), pageStart: String(page).slice(0, 80), echo: echoed };`,
  ].join("\n");
  return { calls, code };
}

async function timeDirect(pool, task, maxResultChars) {
  const started = performance.now();
  const calls = [];
  for (const call of task.calls) {
    const callStarted = performance.now();
    try {
      const value = await pool.call(call, maxResultChars);
      calls.push({ method: `${call.server}.${call.method}`, ok: true, ms: elapsed(callStarted), ...packed(value) });
    } catch (error) {
      calls.push({
        method: `${call.server}.${call.method}`,
        ok: false,
        ms: elapsed(callStarted),
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const bytes = calls.reduce((sum, call) => sum + call.bytes, 0);
  return { ms: elapsed(started), bytes, calls };
}

async function timeCode(mode, code) {
  const started = performance.now();
  const result = await mode.execute(code);
  const payload = { ok: result.ok, result: result.result, error: result.error, logs: result.logs, calls: result.calls };
  return {
    ms: elapsed(started),
    ok: result.ok,
    bytes: jsonBytes(payload),
    resultBytes: jsonBytes(result.result ?? null),
    error: result.error ?? null,
    upstreamMs: result.calls.reduce((sum, call) => sum + call.ms, 0),
    calls: result.calls.map((call) => ({ method: `${call.server}.${call.method}`, ok: call.ok, ms: call.ms })),
  };
}

function packed(value) {
  const json = JSON.stringify(value) ?? "null";
  return { bytes: Buffer.byteLength(json), preview: json.slice(0, 100) };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}
