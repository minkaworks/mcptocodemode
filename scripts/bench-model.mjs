// Model-in-the-loop benchmark: the same model and the same tasks, once with
// every upstream tool exposed directly (plain MCP) and once through the three
// MCPtoCodeMode tools. Tokens and cost are what OpenRouter reports.
//
//   OPENROUTER_API_KEY=... pnpm build && node scripts/bench-model.mjs
//   BENCH_MODELS=anthropic/claude-haiku-5.5 BENCH_RUNS=1 node scripts/bench-model.mjs
//
// The key may also sit in .env. Writes experiments/model-bench.json.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callUpstreamTool, CodeMode, createCodeModeServer, loadConfig, namespaceWithIdent, UpstreamPool } from "../dist/index.js";
import { createMailServer, mailExpected, mailPrompt } from "./fixtures/mail-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write("Set OPENROUTER_API_KEY in the environment or in .env\n");
  process.exit(1);
}

const models = (process.env.BENCH_MODELS ?? "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5").split(",");
const runs = Number(process.env.BENCH_RUNS ?? 3);
const onlyTasks = process.env.BENCH_TASKS?.split(",");
const maxTurns = 40;
const fsRoot = process.env.CODEMODE_FS_ROOT ?? "/tmp/mcptocodemode-demo";
const gitRepo = process.env.CODEMODE_GIT_REPO ?? "/tmp/mcptocodemode-demo-repo";
process.env.CODEMODE_FS_ROOT = fsRoot;
process.env.CODEMODE_MEMORY_FILE = process.env.CODEMODE_MEMORY_FILE ?? path.join(fsRoot, "memory.jsonl");
process.env.CODEMODE_GIT_REPO = gitRepo;

if (!existsSync(path.join(fsRoot, "orders")) || !existsSync(path.join(gitRepo, ".git"))) {
  process.stderr.write("Fixtures are missing. Run `pnpm measure` once to write them.\n");
  process.exit(1);
}

const SYSTEM =
  "You are an agent with MCP tools. Use them to answer. When you are done, reply with only the JSON object the task asks for, with no other text.";

/** Deterministic tasks over the fixtures `pnpm measure` writes. */
const tasks = [
  {
    id: "log",
    prompt: `The file ${fsRoot}/service.log is a service log. How many lines contain " ERROR ", and what is the job number in the last ERROR line? Reply as {"errors": number, "lastJob": number}.`,
    check: (answer) => answer.errors === 20 && answer.lastJob === 1940,
  },
  {
    id: "orders",
    prompt: `${fsRoot}/orders holds one JSON file per order. How many orders have status "paid", and what is the sum of their "total" fields, rounded to 2 decimals? Reply as {"paid": number, "total": number}.`,
    check: (answer) => answer.paid === 19 && Math.abs(answer.total - 1906.81) < 0.005,
  },
  {
    // BENCH_TASKS=mail. Paginated search, a large body, and an image passed to another tool.
    id: "mail",
    prompt: mailPrompt,
    check: (answer) => JSON.stringify(answer) === JSON.stringify(mailExpected),
  },
  {
    id: "mixed",
    prompt: `Using the tools: what is the subject line of the most recent commit in the git repository ${gitRepo}, and what is the exact text in ${fsRoot}/hello.txt without its trailing newline? Reply as {"commit": string, "hello": string}.`,
    check: (answer) => answer.commit === "demo" && answer.hello === "hello from the filesystem server",
  },
];

const config = await loadConfig(path.join(root, "mcptocodemode.reference.example.json"));
process.stderr.write("connecting\n");
const pool = await UpstreamPool.connect(config.servers);

// The mail fixture runs in this process. Both arms see it next to the reference servers.
const mailServer = createMailServer();
const [mailClientTransport, mailServerTransport] = InMemoryTransport.createLinkedPair();
const mailClient = new Client({ name: "bench-mail", version: "0" });
await Promise.all([mailClient.connect(mailClientTransport), mailServer.connect(mailServerTransport)]);
const mailTools = (await mailClient.listTools()).tools;
const catalog = { servers: [...pool.catalog.servers, namespaceWithIdent("mail", "mail", mailTools)] };

const mode = new CodeMode(
  catalog,
  (call) =>
    call.server === "mail"
      ? callUpstreamTool(mailClient, call.tool, call.input, config.limits.maxResultChars, mode.blobs)
      : pool.call(call, config.limits.maxResultChars, mode.blobs),
  { limits: config.limits },
);
const mcp = createCodeModeServer(mode);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const codeClient = new Client({ name: "bench", version: "0" });
await Promise.all([codeClient.connect(clientTransport), mcp.connect(serverTransport)]);

const arms = {
  plain: plainArm(pool, mailClient, mailTools),
  codemode: await codeModeArm(codeClient),
};

const results = [];
try {
  for (const model of models) {
    for (const task of tasks.filter((item) => !onlyTasks || onlyTasks.includes(item.id))) {
      for (const [armName, arm] of Object.entries(arms)) {
        for (let run = 1; run <= runs; run += 1) {
          resetMemory();
          process.stderr.write(`${model} ${task.id} ${armName} ${run}/${runs}\n`);
          const outcome = await runTask(model, task, arm);
          results.push({ model, task: task.id, arm: armName, run, ...outcome });
          process.stderr.write(
            `  ok=${outcome.ok} turns=${outcome.turns} in=${outcome.promptTokens} out=${outcome.completionTokens} $${outcome.cost.toFixed(4)} ${outcome.ms}ms${outcome.error ? ` error=${outcome.error}` : ""}\n`,
          );
        }
      }
    }
  }
} finally {
  await codeClient.close();
  await mcp.close();
  mode.close();
  await mailClient.close();
  await mailServer.close();
  await pool.close();
}

const report = {
  at: new Date().toISOString(),
  node: process.version,
  runs,
  tools: { plain: arms.plain.tools.length, codemode: arms.codemode.tools.length },
  toolBytes: { plain: jsonBytes(arms.plain.tools), codemode: jsonBytes(arms.codemode.tools) },
  summary: summarize(results),
  results,
};
mkdirSync(path.join(root, "experiments"), { recursive: true });
writeFileSync(path.join(root, "experiments", "model-bench.json"), `${JSON.stringify(report, null, 2)}\n`);
printSummary(report.summary);

/** Every upstream tool as a function, the way a client that forwards them all presents them. */
function plainArm(upstream, mail, mailToolList) {
  const byName = new Map();
  const tools = [];
  for (const server of upstream.catalog.servers) {
    if (server.error) continue;
    for (const tool of server.tools) {
      if (tool.kind === "protocol") continue;
      const name = `${server.ident}__${tool.method}`.slice(0, 64);
      byName.set(name, { server: server.ident, method: tool.method, tool: tool.name });
      tools.push(fn(name, tool.description, tool.inputSchema));
    }
  }
  for (const tool of mailToolList) {
    const name = `mail__${tool.name}`;
    byName.set(name, { mail: tool.name });
    tools.push(fn(name, tool.description, tool.inputSchema));
  }
  return {
    tools,
    async call(name, input) {
      const target = byName.get(name);
      if (!target) throw new Error(`Unknown tool ${name}`);
      // A plain client hands the model the content blocks, image data included.
      if (target.mail) return JSON.stringify((await mail.callTool({ name: target.mail, arguments: input })).content);
      return JSON.stringify(await upstream.call({ ...target, input }, config.limits.maxResultChars));
    },
  };
}

/** The three tools exactly as the MCP server lists them. */
async function codeModeArm(client) {
  const listed = await client.listTools();
  return {
    tools: listed.tools.map((tool) => fn(tool.name, tool.description, tool.inputSchema)),
    // Each run starts from an empty session, as a new conversation would.
    reset: () => mode.execute("return null;", { reset: true }),
    async call(name, input) {
      const result = await client.callTool({ name, arguments: input });
      return result.content?.map((block) => block.text ?? "").join("\n") ?? "";
    },
  };
}

function fn(name, description, parameters) {
  return { type: "function", function: { name, description: description ?? "", parameters: parameters ?? { type: "object" } } };
}

async function runTask(model, task, arm) {
  await arm.reset?.();
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task.prompt },
  ];
  const totals = { turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, cost: 0, peakPromptTokens: 0 };
  // What each turn called, with argument and result sizes, to explain a number later.
  const trace = [];
  const started = performance.now();
  try {
    while (totals.turns < maxTurns) {
      const response = await complete(model, messages, arm.tools);
      totals.turns += 1;
      const usage = response.usage ?? {};
      totals.promptTokens += usage.prompt_tokens ?? 0;
      totals.completionTokens += usage.completion_tokens ?? 0;
      totals.cost += usage.cost ?? 0;
      totals.peakPromptTokens = Math.max(totals.peakPromptTokens, usage.prompt_tokens ?? 0);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error(`No message: ${JSON.stringify(response).slice(0, 300)}`);
      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
      if (!message.tool_calls?.length) {
        const answer = parseAnswer(message.content ?? "");
        return { ...totals, ms: elapsed(started), ok: Boolean(answer) && task.check(answer), answer, trace };
      }
      for (const call of message.tool_calls) {
        totals.toolCalls += 1;
        let content;
        try {
          content = await arm.call(call.function.name, JSON.parse(call.function.arguments || "{}"));
        } catch (error) {
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
        trace.push({
          turn: totals.turns,
          tool: call.function.name,
          args: call.function.arguments.slice(0, 600),
          resultBytes: Buffer.byteLength(content),
          resultStart: content.slice(0, 200),
        });
      }
    }
    return { ...totals, ms: elapsed(started), ok: false, error: `no answer after ${maxTurns} turns`, trace };
  } catch (error) {
    return { ...totals, ms: elapsed(started), ok: false, error: error instanceof Error ? error.message : String(error), trace };
  }
}

async function complete(model, messages, tools) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, tools, temperature: 0, usage: { include: true } }),
      });
    } catch (error) {
      // A dropped connection is retried like a 5xx.
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      throw error;
    }
    if (response.ok) return response.json();
    const body = await response.text();
    if (attempt < 4 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      continue;
    }
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 300)}`);
  }
}

function parseAnswer(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function resetMemory() {
  // Keep the memory server from carrying state between runs.
  writeFileSync(process.env.CODEMODE_MEMORY_FILE, "");
  execSync("git status --short", { cwd: gitRepo });
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}|${row.task}|${row.arm}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [model, task, arm] = key.split("|");
    return {
      model,
      task,
      arm,
      runs: list.length,
      passed: list.filter((row) => row.ok).length,
      turns: median(list.map((row) => row.turns)),
      promptTokens: median(list.map((row) => row.promptTokens)),
      peakPromptTokens: median(list.map((row) => row.peakPromptTokens)),
      completionTokens: median(list.map((row) => row.completionTokens)),
      cost: median(list.map((row) => row.cost)),
      ms: median(list.map((row) => row.ms)),
    };
  });
}

function printSummary(rows) {
  const header = ["model", "task", "arm", "pass", "turns", "in tok", "peak in", "out tok", "cost $", "ms"];
  process.stdout.write(`${header.join("\t")}\n`);
  for (const row of rows) {
    process.stdout.write(
      [row.model, row.task, row.arm, `${row.passed}/${row.runs}`, row.turns, row.promptTokens, row.peakPromptTokens, row.completionTokens, row.cost.toFixed(4), row.ms].join("\t") + "\n",
    );
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}
