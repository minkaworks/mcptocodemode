import { BlobStore } from "./blobs.js";
import { describeTarget, renderSdk } from "./describe.js";
import { SandboxSession } from "./sandbox.js";
import { searchCatalog } from "./search.js";
import { defaultLimits, type Catalog, type Dispatcher, type ExecuteResult, type Limits, type ToolCall } from "./types.js";

export type CodeModeOptions = {
  limits?: Partial<Limits>;
  beforeCall?: (call: ToolCall) => void | Promise<void>;
};

/**
 * One session: a sandbox isolate kept across `execute` calls and the blob
 * handles its runs produced. Both are dropped on reset and on `close()`.
 */
export class CodeMode {
  readonly catalog: Catalog;
  readonly limits: Limits;
  /** Pass this to `UpstreamPool.call` so binary results come back as handles. */
  readonly blobs = new BlobStore();
  private readonly session: SandboxSession;

  constructor(catalog: Catalog, dispatcher: Dispatcher, options: CodeModeOptions = {}) {
    this.catalog = catalog;
    this.limits = { ...defaultLimits, ...options.limits };
    // beforeCall sees the handles. The dispatcher receives the bytes.
    const dispatch: Dispatcher = async (call) => {
      await options.beforeCall?.(call);
      return dispatcher({ ...call, input: this.blobs.expand(call.input) as Record<string, unknown> });
    };
    this.session = new SandboxSession(catalog, dispatch, { limits: this.limits, onClear: () => this.blobs.clear() });
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

  /** `reset: true` empties the session (`state`, globals, handles) before running. */
  execute(code: string, options: { timeoutMs?: number; reset?: boolean } = {}): Promise<ExecuteResult> {
    return this.session.execute(code, { timeoutMs: options.timeoutMs ?? this.limits.timeoutMs, reset: options.reset });
  }

  close(): void {
    this.session.close();
  }
}
