import { randomBytes } from "node:crypto";

/** What the guest sees in place of binary content. The bytes stay in the host. */
export type BlobHandle = {
  $handle: string;
  type: string;
  mimeType: string;
};

export type BlobLimits = {
  maxBlobBytes: number;
  maxTotalBytes: number;
};

export const defaultBlobLimits: BlobLimits = {
  maxBlobBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

type Stored = { data: string; type: string; mimeType: string; bytes: number };

const HANDLE_KEYS = new Set(["$handle", "type", "mimeType"]);

/**
 * Images, audio, and resource blobs from tool results, held for one session.
 * Code passes a handle to another tool and that tool receives the base64.
 * The store empties when the session resets.
 */
export class BlobStore {
  private readonly blobs = new Map<string, Stored>();
  private total = 0;

  constructor(readonly limits: BlobLimits = defaultBlobLimits) {}

  /** Keep base64 `data` and return its handle, or undefined when it does not fit. */
  put(data: string, type: string, mimeType: string): BlobHandle | undefined {
    const bytes = decodedLength(data);
    if (bytes > this.limits.maxBlobBytes || this.total + bytes > this.limits.maxTotalBytes) return undefined;
    const id = `blob_${randomBytes(8).toString("hex")}`;
    this.blobs.set(id, { data, type, mimeType, bytes });
    this.total += bytes;
    return { $handle: id, type, mimeType };
  }

  get(id: string): { data: string; type: string; mimeType: string } | undefined {
    const stored = this.blobs.get(id);
    return stored && { data: stored.data, type: stored.type, mimeType: stored.mimeType };
  }

  /** Decoded bytes held now. */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.blobs.size;
  }

  /**
   * Replace every handle in a tool input with its base64. A handle is an object
   * whose only keys are `$handle` and, optionally, `type` and `mimeType`.
   * An unknown id throws, which fails that call.
   */
  expand(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.expand(item));
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if (isHandle(record)) {
      const stored = this.blobs.get(record.$handle);
      if (!stored) throw new Error(`Unknown handle "${record.$handle}". Handles last until the session resets.`);
      return stored.data;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = this.expand(item);
    return out;
  }

  clear(): void {
    this.blobs.clear();
    this.total = 0;
  }
}

function isHandle(record: Record<string, unknown>): record is Record<string, unknown> & { $handle: string } {
  if (typeof record.$handle !== "string") return false;
  return Object.keys(record).every((key) => HANDLE_KEYS.has(key));
}

function decodedLength(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
