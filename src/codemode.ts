import { describeTarget, renderSdk } from "./describe.js";
import { runInSandbox } from "./sandbox.js";
import { searchCatalog } from "./search.js";
import { defaultLimits, type Catalog, type Dispatcher, type ExecuteResult, type Limits, type ToolCall } from "./types.js";

export type CodeModeOptions = {
  limits?: Partial<Limits>;
  beforeCall?: (call: ToolCall) => void | Promise<void>;
};

export class CodeMode {
  readonly catalog: Catalog;
  readonly limits: Limits;
  private readonly dispatch: Dispatcher;

  constructor(catalog: Catalog, dispatcher: Dispatcher, options: CodeModeOptions = {}) {
    this.catalog = catalog;
    this.limits = { ...defaultLimits, ...options.limits };
    this.dispatch = async (call) => {
      await options.beforeCall?.(call);
      return dispatcher(call);
    };
  }

  search(query: string, options: { server?: string; limit?: number } = {}) {
    return searchCatalog(this.catalog, query, options);
  }

  describe(target: string): string {
    return describeTarget(this.catalog, target);
  }

  sdk(): string {
    return renderSdk(this.catalog);
  }

  execute(code: string, options: { timeoutMs?: number } = {}): Promise<ExecuteResult> {
    return runInSandbox(this.catalog, code, this.dispatch, {
      limits: this.limits,
      timeoutMs: options.timeoutMs ?? this.limits.timeoutMs,
    });
  }
}
