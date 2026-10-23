import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** The loopback callback `login` listens on. A registered client is tied to this address. */
export const DEFAULT_CALLBACK_PORT = 33418;

export function callbackUrl(port = DEFAULT_CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}/callback`;
}

/** `$XDG_CONFIG_HOME/mcptocodemode/oauth`, or `~/.config/mcptocodemode/oauth`. */
export function defaultOAuthDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mcptocodemode", "oauth");
}

/** One file per server URL, so the same server under two names shares a sign-in. */
export function oauthFile(dir: string, serverUrl: string): string {
  return path.join(dir, `${createHash("sha256").update(serverUrl).digest("hex").slice(0, 32)}.json`);
}

/** Thrown when a server needs a sign-in and nobody is there to do it, as in `serve`. */
export class NeedsLoginError extends Error {
  constructor(readonly serverName: string) {
    super(`${serverName} needs you to sign in. Run: npx mcptocodemode login ${serverName}`);
  }
}

type Stored = {
  serverUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
};

export type FileOAuthOptions = {
  serverName: string;
  serverUrl: string;
  dir?: string;
  redirectUrl?: string;
  /**
   * Opens the authorization page. Present only in `login`. Without it, a
   * server that needs a sign-in fails with `NeedsLoginError`, and no client is
   * registered with its authorization server.
   */
  onAuthorize?: (url: URL) => void | Promise<void>;
};

/**
 * An OAuth client for one MCP server, with its registration and tokens in a
 * file only the user can read. The SDK drives discovery, PKCE, registration,
 * and refresh; this keeps what they produce.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private verifier?: string;
  private expectedState?: string;

  constructor(private readonly options: FileOAuthOptions) {
    this.file = oauthFile(options.dir ?? defaultOAuthDir(), options.serverUrl);
  }

  get redirectUrl(): string {
    return this.options.redirectUrl ?? callbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcptocodemode",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("hex");
    return this.expectedState;
  }

  /** The state the last authorization URL carried, for checking the callback. */
  get lastState(): string | undefined {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.read().client;
    if (!this.options.onAuthorize) {
      // Without a person, use the saved registration as it is (refreshing needs no callback),
      // and never register a new client.
      if (!client) throw new NeedsLoginError(this.options.serverName);
      return client;
    }
    // A registration for another callback address cannot finish this sign-in. Register again.
    if (client && "redirect_uris" in client && Array.isArray(client.redirect_uris) && !client.redirect_uris.includes(this.redirectUrl)) {
      return undefined;
    }
    return client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ ...this.read(), client });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ ...this.read(), tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.options.onAuthorize) throw new NeedsLoginError(this.options.serverName);
    await this.options.onAuthorize(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No sign-in is in progress");
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const stored = this.read();
    if (scope === "all") this.write({ serverUrl: this.options.serverUrl });
    else if (scope === "client") this.write({ ...stored, client: undefined });
    else if (scope === "tokens") this.write({ ...stored, tokens: undefined });
    else if (scope === "verifier") this.verifier = undefined;
  }

  /** Forget this server's registration and tokens. */
  clear(): void {
    rmSync(this.file, { force: true });
  }

  private read(): Stored {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  private write(stored: Stored): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...stored, serverUrl: this.options.serverUrl })}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/**
 * Wait for one OAuth redirect on the loopback callback and return its code.
 * Rejects on a state mismatch, an error from the authorization server, or a
 * timeout.
 */
export function waitForCallback(
  port: number,
  expectedState: () => string | undefined,
  timeoutMs: number,
): { code: Promise<string>; ready: Promise<void>; close: () => void } {
  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let markReady: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    fail = reject;
  });
  const code = new Promise<string>((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const value = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const ok = !error && value && (!expectedState() || state === expectedState());
      response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        ok
          ? "<!doctype html><title>Signed in</title><p>Signed in to the MCP server. You can close this tab.</p>"
          : "<!doctype html><title>Sign-in failed</title><p>Sign-in did not complete. Return to the terminal.</p>",
      );
      if (error) reject(new Error(`The authorization server refused: ${error}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}`));
      else if (!value) reject(new Error("The callback had no authorization code"));
      else if (!ok) reject(new Error("The callback state did not match this sign-in"));
      else resolve(value);
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE" ? `Port ${port} is in use. Pass --port with a free one.` : `Could not listen on port ${port}: ${error.message}`;
      fail(new Error(message));
      reject(new Error(message));
    });
    server.listen(port, "127.0.0.1", () => markReady());
    timer = setTimeout(() => reject(new Error(`No sign-in within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  const close = () => {
    clearTimeout(timer);
    server?.close();
  };
  void code.then(close, close);
  return { code, ready, close };
}

/** Open a URL in the default browser. The caller also prints it, in case nothing opens. */
export function openBrowser(url: URL): void {
  const target = url.toString();
  const [command, args] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // Printing the URL is the fallback.
  }
}
