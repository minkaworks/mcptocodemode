import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { describeTarget } from "./describe.js";
import { searchCatalog } from "./search.js";
import type { CallTrace, Catalog, Dispatcher, ExecuteResult, Limits } from "./types.js";

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

/**
 * Host promises the guest has not seen settle. A run can end while a call is
 * still in flight (`notes.list(); return 1`). Their resolver handles have to be
 * freed before the context, or QuickJS aborts the whole process.
 */
const pendingByVm = new WeakMap<QuickJSContext, Set<QuickJSDeferredPromise>>();

type RunOptions = {
  limits: Limits;
  timeoutMs: number;
};

export async function runInSandbox(
  catalog: Catalog,
  code: string,
  dispatch: Dispatcher,
  options: RunOptions,
): Promise<ExecuteResult> {
  const logs: string[] = [];
  const calls: CallTrace[] = [];

  if (code.length > options.limits.maxCodeChars) {
    return {
      ok: false,
      error: `Code is ${code.length} characters. The limit is ${options.limits.maxCodeChars}.`,
      logs,
      calls,
    };
  }

  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  let alive = true;
  let callCount = 0;
  const deadline = Date.now() + options.timeoutMs;

  try {
    vm.runtime.setMemoryLimit(options.limits.memoryBytes);
    vm.runtime.setMaxStackSize(1024 * 1024);
    vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    bindConsole(vm, logs);
    bindCodemode(vm, catalog, () => alive);
    bindServers(vm, catalog, async (call) => {
      if (!alive) throw new Error("Execution already finished");
      if (Date.now() > deadline) throw new Error("Execution timed out");
      callCount += 1;
      if (callCount > options.limits.maxCalls) {
        throw new Error(`Stopped after ${options.limits.maxCalls} tool calls`);
      }
      const started = Date.now();
      try {
        const result = await dispatch(call);
        calls.push({ server: call.server, method: call.method, ok: true, ms: Date.now() - started });
        return result;
      } catch (error) {
        calls.push({ server: call.server, method: call.method, ok: false, ms: Date.now() - started });
        throw error;
      }
    }, () => alive);

    let evaluated = vm.evalCode(wrapCode(code));
    if (evaluated.error && looksLikeExpression(code.trim()) && isSyntaxError(vm, evaluated.error)) {
      // `(a).b(); return c` starts like an expression but is a function body.
      evaluated.error.dispose();
      evaluated = vm.evalCode(wrapBody(code));
    }
    if (evaluated.error) {
      const message = readError(vm, evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: normalizeError(message), logs, calls };
    }

    const promiseHandle = evaluated.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wallClock = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Execution timed out")), options.timeoutMs + 500);
    });
    try {
      // Register the host waiter before running jobs. A promise that settles
      // during the first pump is invisible to a later resolvePromise call.
      const pending = vm.resolvePromise(promiseHandle);
      pump(vm, () => alive);
      const settled = await Promise.race([pending, wallClock]);
      pump(vm, () => alive);
      if (settled.error) {
        const message = readError(vm, settled.error);
        settled.error.dispose();
        return { ok: false, error: normalizeError(message), logs, calls };
      }
      const dumped = vm.dump(settled.value);
      settled.value.dispose();
      return { ok: true, result: toJsonValue(dumped), logs, calls };
    } finally {
      if (timer) clearTimeout(timer);
      promiseHandle.dispose();
    }
  } catch (error) {
    return { ok: false, error: normalizeError(error instanceof Error ? error.message : String(error)), logs, calls };
  } finally {
    alive = false;
    for (const deferred of pendingByVm.get(vm) ?? []) deferred.dispose();
    vm.dispose();
  }
}

function isSyntaxError(vm: QuickJSContext, handle: QuickJSHandle): boolean {
  const dumped = vm.dump(handle) as { name?: unknown } | undefined;
  return typeof dumped === "object" && dumped !== null && dumped.name === "SyntaxError";
}

function pump(vm: QuickJSContext, isAlive: () => boolean): void {
  if (!isAlive()) return;
  vm.runtime.executePendingJobs();
}

function bindConsole(vm: QuickJSContext, logs: string[]): void {
  const consoleObj = vm.newObject();
  for (const level of ["log", "info", "warn", "error"] as const) {
    const fn = vm.newFunction(level, (...args) => {
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

function bindCodemode(vm: QuickJSContext, catalog: Catalog, isAlive: () => boolean): void {
  const codemode = vm.newObject();
  const search = hostFunction(
    vm,
    "search",
    async (args) => {
      const query = typeof args[0] === "string" ? args[0] : "";
      const options = isRecord(args[1]) ? args[1] : {};
      const server = typeof options.server === "string" ? options.server : undefined;
      const limit = typeof options.limit === "number" ? options.limit : undefined;
      return searchCatalog(catalog, query, { server, limit });
    },
    isAlive,
  );
  const describe = hostFunction(
    vm,
    "describe",
    async (args) => describeTarget(catalog, typeof args[0] === "string" ? args[0] : ""),
    isAlive,
  );
  vm.setProp(codemode, "search", search);
  vm.setProp(codemode, "describe", describe);
  search.dispose();
  describe.dispose();
  vm.setProp(vm.global, "codemode", codemode);
  codemode.dispose();
}

function bindServers(
  vm: QuickJSContext,
  catalog: Catalog,
  dispatch: Dispatcher,
  isAlive: () => boolean,
): void {
  for (const server of catalog.servers) {
    if (server.error) continue;
    const namespace = vm.newObject();
    for (const tool of server.tools) {
      if (tool.kind === "protocol") continue;
      const fn = hostFunction(
        vm,
        tool.method,
        (args) => {
          const input = args.length === 0 || args[0] === undefined ? {} : args[0];
          if (!isRecord(input)) {
            return Promise.reject(new Error(`${server.ident}.${tool.method} expects an object argument`));
          }
          return dispatch({ server: server.ident, method: tool.method, tool: tool.name, input });
        },
        isAlive,
      );
      vm.setProp(namespace, tool.method, fn);
      fn.dispose();
    }
    bindGroup(vm, namespace, server.ident, "resources", ["list", "read", "templates"], dispatch, isAlive);
    bindGroup(vm, namespace, server.ident, "prompts", ["list", "get"], dispatch, isAlive);
    vm.setProp(vm.global, server.ident, namespace);
    namespace.dispose();
  }
}

function bindGroup(
  vm: QuickJSContext,
  namespace: QuickJSHandle,
  serverIdent: string,
  groupName: string,
  actions: string[],
  dispatch: Dispatcher,
  isAlive: () => boolean,
): void {
  const group = vm.newObject();
  for (const action of actions) {
    const method = `${groupName}.${action}`;
    const fn = hostFunction(
      vm,
      action,
      async (args) => {
        const input = args.length === 0 || args[0] === undefined ? {} : args[0];
        if (!isRecord(input)) throw new Error(`${serverIdent}.${method} expects an object argument`);
        return dispatch({ server: serverIdent, method, tool: method, input });
      },
      isAlive,
    );
    vm.setProp(group, action, fn);
    fn.dispose();
  }
  vm.setProp(namespace, groupName, group);
  group.dispose();
}

function hostFunction(
  vm: QuickJSContext,
  name: string,
  fn: (args: unknown[]) => Promise<unknown>,
  isAlive: () => boolean,
): QuickJSHandle {
  return vm.newFunction(name, (...argHandles) => {
    const args = argHandles.map((handle) => vm.dump(handle));
    const deferred = vm.newPromise();
    let pending = pendingByVm.get(vm);
    if (!pending) {
      pending = new Set();
      pendingByVm.set(vm, pending);
    }
    pending.add(deferred);
    void deferred.settled.then(() => pending.delete(deferred));
    fn(args).then(
      (value) => {
        if (!isAlive()) return;
        const imported = jsonToHandle(vm, value);
        deferred.resolve(imported.handle);
        if (imported.owned) imported.handle.dispose();
        deferred.settled.then(() => {
          if (isAlive()) vm.runtime.executePendingJobs();
        });
      },
      (error: unknown) => {
        if (!isAlive()) return;
        const message = error instanceof Error ? error.message : String(error);
        const handle = vm.newString(message);
        deferred.reject(handle);
        handle.dispose();
        deferred.settled.then(() => {
          if (isAlive()) vm.runtime.executePendingJobs();
        });
      },
    );
    return deferred.handle;
  });
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
