import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { describeTarget } from "./describe.js";
import { searchCatalog } from "./search.js";
import type { CallSummary, CallTrace, Catalog, Dispatcher, ExecuteResult, Limits, ToolCall } from "./types.js";

export function wrapCode(code: string): string {
  const trimmed = code.trim();
  if (looksLikeExpression(trimmed)) {
    // A function expression is called. Anything else that parses as an
    // expression, such as an IIFE the model already invoked, is its value.
    return `(async () => {\nconst __entry = (${trimmed});\nreturn typeof __entry === "function" ? await __entry() : await __entry;\n})()`;
  }
  return wrapBody(code);
}

function wrapBody(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

function looksLikeExpression(trimmed: string): boolean {
  return /^(async\s+)?function\b/.test(trimmed) || /^(async\s*)?\(/.test(trimmed) || trimmed.startsWith("async ");
}

export const OVERLAP_ERROR = "Another execute is still running.";
const CLEARED = "The session was cleared.";

/** What one execute owns. Budgets, logs, and the trace do not carry over to the next run. */
type Run = {
  logs: string[];
  calls: CallTrace[];
  callCount: number;
  /** Moves later while the run waits on a person (see `whilePaused`). */
  deadline: number;
  /** Host waits that do not count against the deadline, such as an install confirmation. */
  paused: number;
  alive: boolean;
  /**
   * Host promises the guest has not seen settle. A run can end while a call is
   * still in flight (`notes.list(); return 1`). Their resolver handles have to
   * be freed when the run ends, or QuickJS aborts when the context goes.
   */
  pending: Set<QuickJSDeferredPromise>;
};

export type SessionOptions = {
  limits: Limits;
  /** Registry matches for a query, added to `codemode.search` results as `available`. */
  discover?: (query: string) => Promise<Record<string, unknown> | undefined>;
  /** Installs a registry server after a person confirms. Backs `codemode.install`. */
  install?: (name: string) => Promise<unknown>;
  /** Called whenever the isolate is thrown away: reset, a poisoned run, or close. */
  onClear?: () => void;
};

/**
 * One QuickJS isolate kept across execute calls. `let`, `const`, and function
 * declarations live inside each run's async function and do not survive. The
 * `state` global, and anything else put on `globalThis`, does.
 */
export class SandboxSession {
  private vm?: QuickJSContext;
  private run?: Run;
  private busy = false;
  /** Server idents this session bound, with the method names under each. */
  private readonly bound = new Map<string, Set<string>>();

  constructor(
    private readonly catalog: Catalog,
    private readonly dispatch: Dispatcher,
    private readonly options: SessionOptions,
  ) {}

  async execute(code: string, options: { timeoutMs: number; reset?: boolean }): Promise<ExecuteResult> {
    if (this.busy) return { ok: false, error: OVERLAP_ERROR, logs: [], calls: [] };
    const { limits } = this.options;
    if (code.length > limits.maxCodeChars) {
      return { ok: false, error: `Code is ${code.length} characters. The limit is ${limits.maxCodeChars}.`, logs: [], calls: [] };
    }

    this.busy = true;
    const run: Run = {
      logs: [],
      calls: [],
      callCount: 0,
      deadline: Date.now() + options.timeoutMs,
      paused: 0,
      alive: true,
      pending: new Set(),
    };
    let poisoned = false;
    try {
      if (options.reset) this.clear();
      const vm = await this.context();
      this.ensureBindings(vm);
      this.run = run;
      vm.runtime.setInterruptHandler(() => Date.now() > run.deadline);
      const outcome = await this.evaluate(vm, code, run);
      poisoned = outcome.poisoned;
      if (!outcome.ok) {
        const error = poisoned ? `${outcome.error}. ${CLEARED}` : outcome.error;
        return { ok: false, error, logs: run.logs, calls: run.calls };
      }
      const allOk = run.calls.every((call) => call.ok);
      return { ok: true, result: outcome.result, logs: run.logs, calls: allOk ? summarize(run.calls) : run.calls };
    } catch (error) {
      poisoned = true;
      const message = normalizeError(error instanceof Error ? error.message : String(error));
      return { ok: false, error: `${message}. ${CLEARED}`, logs: run.logs, calls: run.calls };
    } finally {
      this.endRun(run);
      if (poisoned) this.clear();
      else this.vm?.runtime.removeInterruptHandler();
      this.busy = false;
    }
  }

  /** Throw the isolate away. The next execute starts with an empty `state`. */
  clear(): void {
    if (this.run) this.endRun(this.run);
    if (this.vm) {
      this.vm.dispose();
      this.vm = undefined;
    }
    this.bound.clear();
    this.options.onClear?.();
  }

  close(): void {
    this.clear();
  }

  private endRun(run: Run): void {
    run.alive = false;
    for (const deferred of run.pending) deferred.dispose();
    run.pending.clear();
    if (this.run === run) this.run = undefined;
  }

  private async context(): Promise<QuickJSContext> {
    if (this.vm) return this.vm;
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    // The runtime lives as long as the session, so the memory cap is the session's.
    vm.runtime.setMemoryLimit(this.options.limits.memoryBytes);
    vm.runtime.setMaxStackSize(1024 * 1024);
    this.bindConsole(vm);
    this.bindCodemode(vm);
    const state = vm.newObject();
    vm.setProp(vm.global, "state", state);
    state.dispose();
    this.vm = vm;
    return vm;
  }

  private async evaluate(
    vm: QuickJSContext,
    code: string,
    run: Run,
  ): Promise<{ ok: true; result: unknown; poisoned: false } | { ok: false; error: string; poisoned: boolean }> {
    let evaluated = vm.evalCode(wrapCode(code));
    if (evaluated.error && looksLikeExpression(code.trim()) && isSyntaxError(vm, evaluated.error)) {
      // `(a).b(); return c` starts like an expression but is a function body.
      evaluated.error.dispose();
      evaluated = vm.evalCode(wrapBody(code));
    }
    if (evaluated.error) {
      const message = readError(vm, evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: normalizeError(message), poisoned: isPoison(message) };
    }

    const promiseHandle = evaluated.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Rechecks the deadline when it fires, since a pause can have moved it.
    const wallClock = new Promise<never>((_, reject) => {
      const check = () => {
        const left = run.deadline + 500 - Date.now();
        if (run.paused > 0 || left > 0) timer = setTimeout(check, Math.max(left, 100));
        else reject(new Error("Execution timed out"));
      };
      timer = setTimeout(check, Math.max(run.deadline + 500 - Date.now(), 0));
    });
    try {
      // Register the host waiter before running jobs. A promise that settles
      // during the first pump is invisible to a later resolvePromise call.
      const pending = vm.resolvePromise(promiseHandle);
      pump(vm, run);
      const settled = await Promise.race([pending, wallClock]);
      pump(vm, run);
      if (settled.error) {
        const message = readError(vm, settled.error);
        settled.error.dispose();
        return { ok: false, error: normalizeError(message), poisoned: isPoison(message) };
      }
      const dumped = vm.dump(settled.value);
      settled.value.dispose();
      return { ok: true, result: toJsonValue(dumped), poisoned: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: normalizeError(message), poisoned: true };
    } finally {
      if (timer) clearTimeout(timer);
      promiseHandle.dispose();
    }
  }

  /** Each call is charged to the run it started in. */
  private async callTool(call: ToolCall, run: Run): Promise<unknown> {
    if (Date.now() > run.deadline) throw new Error("Execution timed out");
    run.callCount += 1;
    if (run.callCount > this.options.limits.maxCalls) {
      throw new Error(`Stopped after ${this.options.limits.maxCalls} tool calls`);
    }
    const started = Date.now();
    try {
      const result = await this.dispatch(call);
      run.calls.push({ server: call.server, method: call.method, ok: true, ms: Date.now() - started });
      return result;
    } catch (error) {
      run.calls.push({ server: call.server, method: call.method, ok: false, ms: Date.now() - started });
      throw error;
    }
  }

  private bindConsole(vm: QuickJSContext): void {
    const consoleObj = vm.newObject();
    for (const level of ["log", "info", "warn", "error"] as const) {
      const fn = vm.newFunction(level, (...args) => {
        const logs = this.run?.logs;
        if (!logs) return;
        const text = args
          .map((handle) => {
            const value = vm.dump(handle);
            return typeof value === "string" ? value : safeStringify(value);
          })
          .join(" ");
        const line = level === "log" || level === "info" ? text : `${level}: ${text}`;
        if (logs.length < 200) logs.push(line.slice(0, 1000));
      });
      vm.setProp(consoleObj, level, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();
  }

  private bindCodemode(vm: QuickJSContext): void {
    const codemode = vm.newObject();
    const search = this.hostFunction(vm, "search", async (args) => {
      const query = typeof args[0] === "string" ? args[0] : "";
      const options = isRecord(args[1]) ? args[1] : {};
      const server = typeof options.server === "string" ? options.server : undefined;
      const limit = typeof options.limit === "number" ? options.limit : undefined;
      const local = searchCatalog(this.catalog, query, { server, limit });
      return { ...local, ...(await this.options.discover?.(query)) };
    });
    const install = this.hostFunction(vm, "install", async (args, run) => {
      if (!this.options.install) throw new Error("Installing servers is off. Start mcptocodemode with --registry to turn it on.");
      const name = typeof args[0] === "string" ? args[0] : "";
      const result = await whilePaused(run, this.options.install(name));
      // Bind it now, so the rest of this program can call it.
      if (this.vm === vm) this.ensureBindings(vm);
      return result;
    });
    vm.setProp(codemode, "install", install);
    install.dispose();
    const describe = this.hostFunction(vm, "describe", async (args) =>
      describeTarget(this.catalog, typeof args[0] === "string" ? args[0] : ""),
    );
    vm.setProp(codemode, "search", search);
    vm.setProp(codemode, "describe", describe);
    search.dispose();
    describe.dispose();
    vm.setProp(vm.global, "codemode", codemode);
    codemode.dispose();
  }

  /**
   * Bind every connected server and method the isolate does not have yet. A
   * server that connected after the last run appears now. A global the guest
   * already defined under that name is left alone.
   */
  private ensureBindings(vm: QuickJSContext): void {
    for (const server of this.catalog.servers) {
      if (server.error) continue;
      let methods = this.bound.get(server.ident);
      let namespace: QuickJSHandle;
      if (!methods) {
        const existing = vm.getProp(vm.global, server.ident);
        const taken = vm.typeof(existing) !== "undefined";
        existing.dispose();
        if (taken) continue;
        namespace = vm.newObject();
        vm.setProp(vm.global, server.ident, namespace);
        methods = new Set();
        this.bound.set(server.ident, methods);
      } else {
        namespace = vm.getProp(vm.global, server.ident);
        if (vm.typeof(namespace) !== "object") {
          namespace.dispose();
          continue;
        }
      }
      for (const tool of server.tools) {
        if (tool.kind === "protocol" || methods.has(tool.method)) continue;
        const fn = this.hostFunction(vm, tool.method, (args, run) => {
          const input = args.length === 0 || args[0] === undefined ? {} : args[0];
          if (!isRecord(input)) {
            return Promise.reject(new Error(`${server.ident}.${tool.method} expects an object argument`));
          }
          return this.callTool({ server: server.ident, method: tool.method, tool: tool.name, input }, run);
        });
        vm.setProp(namespace, tool.method, fn);
        fn.dispose();
        methods.add(tool.method);
      }
      for (const [group, actions] of [
        ["resources", ["list", "read", "templates"]],
        ["prompts", ["list", "get"]],
      ] as const) {
        if (methods.has(group)) continue;
        this.bindGroup(vm, namespace, server.ident, group, actions);
        methods.add(group);
      }
      namespace.dispose();
    }
  }

  private bindGroup(
    vm: QuickJSContext,
    namespace: QuickJSHandle,
    serverIdent: string,
    groupName: string,
    actions: readonly string[],
  ): void {
    const group = vm.newObject();
    for (const action of actions) {
      const method = `${groupName}.${action}`;
      const fn = this.hostFunction(vm, action, async (args, run) => {
        const input = args.length === 0 || args[0] === undefined ? {} : args[0];
        if (!isRecord(input)) throw new Error(`${serverIdent}.${method} expects an object argument`);
        return this.callTool({ server: serverIdent, method, tool: method, input }, run);
      });
      vm.setProp(group, action, fn);
      fn.dispose();
    }
    vm.setProp(namespace, groupName, group);
    group.dispose();
  }

  private hostFunction(
    vm: QuickJSContext,
    name: string,
    fn: (args: unknown[], run: Run) => Promise<unknown>,
  ): QuickJSHandle {
    return vm.newFunction(name, (...argHandles) => {
      const run = this.run;
      const args = argHandles.map((handle) => vm.dump(handle));
      const deferred = vm.newPromise();
      if (!run?.alive) {
        const handle = vm.newString("Execution already finished");
        deferred.reject(handle);
        handle.dispose();
        return deferred.handle;
      }
      run.pending.add(deferred);
      void deferred.settled.then(() => run.pending.delete(deferred));
      fn(args, run).then(
        (value) => {
          if (!run.alive) return;
          const imported = jsonToHandle(vm, value);
          deferred.resolve(imported.handle);
          if (imported.owned) imported.handle.dispose();
          void deferred.settled.then(() => {
            if (run.alive) vm.runtime.executePendingJobs();
          });
        },
        (error: unknown) => {
          if (!run.alive) return;
          const message = error instanceof Error ? error.message : String(error);
          const handle = vm.newString(message);
          deferred.reject(handle);
          handle.dispose();
          void deferred.settled.then(() => {
            if (run.alive) vm.runtime.executePendingJobs();
          });
        },
      );
      return deferred.handle;
    });
  }
}

type RunOptions = {
  limits: Limits;
  timeoutMs: number;
};

/** One run in a session of its own, for callers that do not keep a CodeMode. */
export async function runInSandbox(
  catalog: Catalog,
  code: string,
  dispatch: Dispatcher,
  options: RunOptions,
): Promise<ExecuteResult> {
  const session = new SandboxSession(catalog, dispatch, { limits: options.limits });
  try {
    return await session.execute(code, { timeoutMs: options.timeoutMs });
  } finally {
    session.close();
  }
}

/** Wait without spending the run's time budget, for steps that wait on a person. */
async function whilePaused<T>(run: Run, work: Promise<T>): Promise<T> {
  run.paused += 1;
  const started = Date.now();
  try {
    return await work;
  } finally {
    run.paused -= 1;
    run.deadline += Date.now() - started;
  }
}

/** One entry per method, in first-call order, with the time summed. */
function summarize(calls: CallTrace[]): CallSummary[] {
  const byMethod = new Map<string, CallSummary>();
  for (const call of calls) {
    const key = `${call.server}\u0000${call.method}`;
    const entry = byMethod.get(key) ?? { server: call.server, method: call.method, count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += call.ms;
    byMethod.set(key, entry);
  }
  return [...byMethod.values()];
}

/** A run that hit the deadline or the memory cap leaves the isolate in an unknown state. */
function isPoison(message: string): boolean {
  return /interrupted|out of memory|Execution timed out/i.test(message);
}

function isSyntaxError(vm: QuickJSContext, handle: QuickJSHandle): boolean {
  const dumped = vm.dump(handle) as { name?: unknown } | undefined;
  return typeof dumped === "object" && dumped !== null && dumped.name === "SyntaxError";
}

function pump(vm: QuickJSContext, run: Run): void {
  if (!run.alive) return;
  vm.runtime.executePendingJobs();
}

function jsonToHandle(vm: QuickJSContext, value: unknown): { handle: QuickJSHandle; owned: boolean } {
  if (value === undefined) return { handle: vm.undefined, owned: false };
  if (value === null) return { handle: vm.null, owned: false };
  const json = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  const handle = vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(json)})`));
  return { handle, owned: true };
}

function readError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle);
  if (typeof dumped === "string") return dumped;
  if (dumped && typeof dumped === "object" && "message" in dumped) {
    const record = dumped as { name?: unknown; message?: unknown };
    const name = record.name ? `${String(record.name)}: ` : "";
    return name + String(record.message ?? dumped);
  }
  return safeStringify(dumped);
}

function normalizeError(message: string): string {
  if (message.includes("interrupted")) return "Execution timed out";
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const json = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  if (json === undefined) return null;
  return JSON.parse(json) as unknown;
}
