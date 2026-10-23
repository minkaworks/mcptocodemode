import { realpath } from "node:fs/promises";
import * as prompt from "@clack/prompts";
import { AGENT_SERVER_NAME, detectAgents, onPath, type AgentEnvironment, type AgentTarget } from "./agents.js";

export type SetupOptions = AgentEnvironment & {
  /** Agent ids to use instead of asking. */
  agents?: string[];
  /** Use every detected agent and the defaults without asking. */
  yes?: boolean;
  remove?: boolean;
  readOnly?: boolean;
  registry?: boolean;
  /** How agents start the server. Asked when both are possible and not given. */
  launch?: "installed" | "npx";
  dryRun?: boolean;
  /** False when there is no terminal to ask in. */
  interactive?: boolean;
  /** The script this process runs, to tell whether it is the installed command. */
  script?: string;
};

const color = (code: number) => (text: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
const bold = color(1);
const dim = color(2);
const green = color(32);
const cyan = color(36);
const inverse = color(7);

/**
 * Add MCPtoCodeMode to the coding agents on this machine, or take it out
 * again. Shows what will change and asks before changing anything.
 */
export async function runSetup(options: SetupOptions = {}): Promise<{ changed: string[]; failed: string[] }> {
  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const ask = interactive && !options.yes;
  prompt.intro(inverse(bold(options.remove ? " mcptocodemode setup --remove " : " mcptocodemode setup ")));

  const looking = prompt.spinner();
  looking.start("Looking for coding agents");
  const all = await detectAgents(options);
  const found = all.filter((agent) => (options.remove ? agent.added : agent.detected));
  looking.stop(
    found.length > 0
      ? `Found ${found.length} ${options.remove ? "with MCPtoCodeMode" : `coding agent${found.length === 1 ? "" : "s"}`}: ${found.map((agent) => agent.name).join(", ")}`
      : options.remove
        ? "No agent has MCPtoCodeMode"
        : "No coding agents found",
  );
  if (found.length === 0) {
    if (!options.remove) prompt.note(manualSnippet(), "Add it by hand");
    prompt.outro("Nothing changed.");
    return { changed: [], failed: [] };
  }

  const chosen = await chooseAgents(found, options, ask);
  if (!chosen) return cancelled();

  let command = "";
  let args: string[] = [];
  if (!options.remove) {
    const features = await chooseFeatures(options, ask);
    if (!features) return cancelled();
    const launch = await chooseLaunch(options, ask);
    if (!launch) return cancelled();
    const argv = [...launch, "serve", ...(features.readOnly ? ["--read-only"] : []), ...(features.registry ? ["--registry"] : [])];
    command = argv[0] ?? "npx";
    args = argv.slice(1);
  }

  prompt.note(
    [
      ...(options.remove ? [] : [`${dim("Runs")}  ${cyan([command, ...args].join(" "))}`, ""]),
      ...chosen.map(
        (agent) => `${bold(agent.name.padEnd(15))} ${dim(agent.where)}${!options.remove && agent.added ? dim("  (updates it)") : ""}`,
      ),
    ].join("\n"),
    options.remove ? "Will remove it from" : `Will add "${AGENT_SERVER_NAME}" to`,
  );
  if (options.dryRun) {
    prompt.outro("Dry run. Nothing changed.");
    return { changed: [], failed: [] };
  }
  if (ask) {
    const ok = await prompt.confirm({
      message: options.remove
        ? `Remove MCPtoCodeMode from ${chosen.length} agent${chosen.length === 1 ? "" : "s"}?`
        : `Add MCPtoCodeMode to ${chosen.length} agent${chosen.length === 1 ? "" : "s"}?`,
    });
    if (prompt.isCancel(ok) || !ok) return cancelled();
  } else if (!interactive && !options.yes) {
    prompt.outro("No terminal to confirm in. Run it in a terminal, or pass --yes.");
    return { changed: [], failed: [] };
  }

  const changed: string[] = [];
  const failed: string[] = [];
  for (const agent of chosen) {
    const progress = prompt.spinner();
    progress.start(`${options.remove ? "Removing from" : "Adding to"} ${agent.name}`);
    try {
      if (options.remove) await agent.remove();
      else await agent.add(command, args);
      changed.push(agent.id);
      progress.stop(`${green("✓")} ${agent.name}  ${dim(agent.method)}`);
    } catch (error) {
      failed.push(agent.id);
      progress.error(`${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!options.remove && changed.length > 0) {
    prompt.note(
      [
        "Restart those agents to load it.",
        "",
        `${cyan("cm find postgres")}   ${dim("find a server in the MCP registry")}`,
        `${cyan("cm add <name>")}      ${dim("install one")}`,
        `${cyan("cm login <server>")}  ${dim("sign in to a remote server")}`,
        `${cyan("cm list")}            ${dim("see what the model can call")}`,
      ].join("\n"),
      "Next",
    );
  }
  prompt.outro(
    failed.length > 0
      ? `${failed.length} failed, ${changed.length} done.`
      : options.remove
        ? `Removed from ${changed.length} agent${changed.length === 1 ? "" : "s"}.`
        : `MCPtoCodeMode is in ${changed.length} agent${changed.length === 1 ? "" : "s"}.`,
  );
  return { changed, failed };
}

async function chooseAgents(found: AgentTarget[], options: SetupOptions, ask: boolean): Promise<AgentTarget[] | undefined> {
  if (options.agents) {
    const unknown = options.agents.filter((id) => !found.some((agent) => agent.id === id));
    if (unknown.length > 0) prompt.log.warn(`Not found here: ${unknown.join(", ")}. Known: ${found.map((agent) => agent.id).join(", ")}`);
    return found.filter((agent) => options.agents?.includes(agent.id));
  }
  if (!ask) return found;
  const picked = await prompt.multiselect({
    message: options.remove ? "Remove it from which agents?" : "Where should MCPtoCodeMode be added?",
    options: found.map((agent) => ({
      value: agent.id,
      label: agent.name,
      hint: !options.remove && agent.added ? `already added, will update · ${agent.where}` : agent.where,
    })),
    initialValues: found.map((agent) => agent.id),
    required: true,
  });
  if (prompt.isCancel(picked)) return undefined;
  return found.filter((agent) => picked.includes(agent.id));
}

async function chooseFeatures(options: SetupOptions, ask: boolean): Promise<{ readOnly: boolean; registry: boolean } | undefined> {
  if (!ask || options.readOnly !== undefined || options.registry !== undefined) {
    return { readOnly: options.readOnly ?? false, registry: options.registry ?? false };
  }
  const picked = await prompt.multiselect({
    message: "Turn on any of these? (space to toggle, enter to continue)",
    options: [
      { value: "readOnly", label: "Read-only mode", hint: "refuses tools that write, so agents can run code without asking" },
      { value: "registry", label: "Registry", hint: "the model can find and install servers, after you confirm each one" },
    ],
    required: false,
  });
  if (prompt.isCancel(picked)) return undefined;
  return { readOnly: picked.includes("readOnly"), registry: picked.includes("registry") };
}

/** The command and leading args agents run. */
async function chooseLaunch(options: SetupOptions, ask: boolean): Promise<string[] | undefined> {
  const env = { env: options.env ?? process.env, platform: options.platform ?? process.platform };
  const installed = await installedCommand(options.script ?? process.argv[1], env);
  const npx = (await onPath(env, "npx")) ?? "npx";
  const npxLaunch = [npx, "-y", "mcptocodemode"];
  if (options.launch === "npx" || !installed) return npxLaunch;
  if (options.launch === "installed" || !ask) return [installed];
  const picked = await prompt.select({
    message: "How should agents start it?",
    options: [
      { value: "installed", label: "The installed command", hint: `${installed} · starts fastest` },
      { value: "npx", label: "npx", hint: "always the latest version · checks npm at every start" },
    ],
    initialValue: "installed",
  });
  if (prompt.isCancel(picked)) return undefined;
  return picked === "installed" ? [installed] : npxLaunch;
}

/**
 * The absolute path of the globally installed `mcptocodemode`, when this
 * process is that install. Absolute, since agents started from a dock or a
 * menu often have a shorter PATH than a terminal.
 */
async function installedCommand(script: string | undefined, env: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }): Promise<string | undefined> {
  const onDisk = await onPath(env, "mcptocodemode");
  if (!onDisk || !script) return undefined;
  try {
    return (await realpath(onDisk)) === (await realpath(script)) ? onDisk : undefined;
  } catch {
    return undefined;
  }
}

function cancelled(): { changed: string[]; failed: string[] } {
  prompt.cancel("Nothing changed.");
  return { changed: [], failed: [] };
}

function manualSnippet(): string {
  return JSON.stringify({ mcpServers: { [AGENT_SERVER_NAME]: { command: "npx", args: ["-y", "mcptocodemode", "serve"] } } }, null, 2);
}
