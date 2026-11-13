import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WS_PORT,
  ErrorCodes,
  PROTOCOL_VERSION,
  bridgeError,
  discoveryPorts,
  isMutatingRpc,
  parseInstanceName,
  parseAutoAllow,
  type BridgeHealth,
  type BridgeIdentity,
  type BridgeMessage,
  type BridgeState,
  type ControlChangedPayload,
  type EventMessage,
  type RequestMessage,
  type ResponseMessage,
  type WelcomeMessage,
} from "@dev-tool-mcp/shared";
import {
  applyExtensionState,
  getBridgeState,
  markExtensionConnected,
} from "./state.js";
import {
  chromeLaunchDisabled,
  configuredBrowserBin,
  isBrowserRunning,
  launchBrowser,
} from "./chrome.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: string }) => void;
  timer: NodeJS.Timeout;
};

/** How long to wait for a server `close()` callback before giving up on it. */
const CLOSE_TIMEOUT_MS = 1_000;

/** Read a millisecond timeout from the environment, with a sane default. */
function envTimeout(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** A just-woken extension service worker gets this long to dial us. */
const EXTENSION_WAIT_MS = 5_000;
/** Chrome startup + extension boot can take a little while on a cold machine. */
const CHROME_START_WAIT_MS = envTimeout(
  "DEV_TOOL_MCP_CHROME_CONNECT_TIMEOUT_MS",
  25_000,
);
/** Do not block every tool call while Chrome is closed or the extension is off. */
const CONNECT_ATTEMPT_COOLDOWN_MS = 10_000;

/**
 * Run a `close()` that may legitimately never invoke its callback (a server
 * that was never listening, or one whose peers do not disconnect). Resolving
 * anyway is what keeps shutdown from hanging forever.
 */
function closeWithDeadline(
  start: (done: () => void) => void,
  ms = CLOSE_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    try {
      start(finish);
    } catch {
      // Nothing to close, or already closed.
      finish();
    }
  });
}

/**
 * Probe an in-use port to see whether the listener is another dev-tool-mcp
 * bridge (rather than an unrelated process squatting on it).
 */
async function probeBridge(
  port: number,
): Promise<{ extensionConnected: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      extensionConnected?: boolean;
    };
    if (!body?.ok) return null;
    return { extensionConnected: body.extensionConnected === true };
  } catch {
    return null;
  }
}

export class WsBridge {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private consoleBuffer: unknown[] = [];
  private networkBuffer: unknown[] = [];
  private boundPort: number | null = null;
  /** Port the extension says it controls; null until it announces a choice. */
  private activePort: number | null = null;
  private readonly startedAt = Date.now();
  /** Throttles the launch/wait logic so failures do not stall every call. */
  private lastConnectAttempt = 0;
  private connectAttempt: Promise<void> | null = null;
  /** Set by stop() so an in-flight launch cannot open Chrome during shutdown. */
  private stopped = false;
  /** Port we were asked to use; the bound port may differ after fallback. */
  readonly preferredPort: number;
  readonly token: string;

  constructor(token: string, port = DEFAULT_WS_PORT) {
    this.token = token;
    this.preferredPort =
      Number(process.env.DEV_TOOL_MCP_WS_PORT) || port || DEFAULT_WS_PORT;
  }

  /** Actually bound port; falls back to the preferred port before binding. */
  get port(): number {
    return this.boundPort ?? this.preferredPort;
  }

  isListening(): boolean {
    return this.boundPort !== null;
  }

  get identity(): BridgeIdentity {
    return {
      pid: process.pid,
      cwd: process.cwd(),
      startedAt: this.startedAt,
      port: this.port,
      preferredPort: this.preferredPort,
      name: parseInstanceName(process.env.DEV_TOOL_MCP_NAME),
      autoAllow: parseAutoAllow(process.env.DEV_TOOL_MCP_AUTO_ALLOW),
    };
  }

  /**
   * Whether the extension picked this bridge. null means the extension has not
   * announced a choice yet, so we must not claim the port is unauthorized.
   */
  get authorized(): boolean | null {
    if (this.activePort === null) return null;
    return this.activePort === this.port;
  }

  /**
   * Bind the bridge. A busy preferred port is NOT fatal: we walk the discovery
   * band instead. Callers must not let a bind failure abort process startup —
   * otherwise a second concurrent client loses every tool this server exposes.
   *
   * We stay inside the band rather than taking an ephemeral port: the extension
   * finds instances by scanning it, and a random high port is invisible there.
   */
  async start(): Promise<void> {
    this.stopped = false;
    let lastErr: unknown = null;

    for (const candidate of discoveryPorts(this.preferredPort)) {
      try {
        await this.listenOn(candidate);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        lastErr = err;
      }
    }

    if (!this.isListening()) {
      throw (
        lastErr ??
        new Error("No free port available in the dev-tool-mcp discovery band.")
      );
    }

    if (this.port !== this.preferredPort) {
      const owner = await probeBridge(this.preferredPort);
      console.error(
        owner
          ? `[dev-tool-mcp] Port ${this.preferredPort} is owned by another dev-tool-mcp instance; bound ${this.port} instead.`
          : `[dev-tool-mcp] Port ${this.preferredPort} is in use by an unrelated process; bound ${this.port} instead.`,
      );
      console.error(
        `[dev-tool-mcp] This instance is on port ${this.port}; mutating tools will request control via a Chrome notification (or the popup Control button).`,
      );
    }

    console.error(
      `[dev-tool-mcp] WebSocket bridge listening on ws://127.0.0.1:${this.port}`,
    );
  }

  private async listenOn(port: number): Promise<void> {
    const httpServer = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: httpServer, path: "/" });
    wss.on("connection", (ws) => this.onConnection(ws));

    // `ws` re-emits the underlying HTTP server's "error" on the
    // WebSocketServer. Both need a listener: an unheard 'error' event is a
    // hard process crash, which would kill us before the fallback can run.
    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        httpServer.once("error", onError);
        wss.once("error", onError);
        httpServer.listen(port, "127.0.0.1", () => {
          if (settled) return;
          settled = true;
          httpServer.removeListener("error", onError);
          wss.removeListener("error", onError);
          resolve();
        });
      });
    } catch (err) {
      // Tear down the half-built listener so the retry starts clean.
      wss.close();
      httpServer.close();
      throw err;
    }

    // Keep a permanent guard so a later listener error cannot crash the server.
    wss.on("error", (err: Error) => {
      console.error(`[dev-tool-mcp] WS server error: ${err.message}`);
    });

    const addr = httpServer.address();
    this.httpServer = httpServer;
    this.wss = wss;
    this.boundPort =
      typeof addr === "object" && addr !== null ? addr.port : port;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("Bridge shutting down"), { code: ErrorCodes.EXTENSION_DISCONNECTED }));
      this.pending.delete(id);
    }

    const socket = this.socket;
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.socket = null;
    this.wss = null;
    this.httpServer = null;
    this.boundPort = null;

    try {
      socket?.close();
    } catch {
      // already closing
    }

    // Both closes are best-effort: if either never calls back we still resolve,
    // so SIGTERM/SIGINT cannot leave an orphaned process holding a port.
    const closes: Array<Promise<void>> = [];
    if (wss) closes.push(closeWithDeadline((done) => wss.close(() => done())));
    if (httpServer) {
      closes.push(closeWithDeadline((done) => httpServer.close(() => done())));
    }
    await Promise.all(closes);
  }

  isExtensionConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Poll until the extension attaches, `ms` elapses, or the bridge stops. */
  private async waitForExtension(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.stopped && Date.now() < deadline) {
      if (this.isExtensionConnected()) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !this.stopped && this.isExtensionConnected();
  }

  /**
   * Make a best effort to get the extension connected before failing a tool
   * call: wait for a reconnecting service worker, and if no Chrome process is
   * running, launch Chrome (normal profile, so the installed extension keeps
   * its permissions) and wait for it to dial in.
   */
  private ensureExtensionConnection(): Promise<void> {
    if (this.isExtensionConnected() || this.stopped) {
      return Promise.resolve();
    }
    if (this.connectAttempt) return this.connectAttempt;
    // Throttle: a closed Chrome (or a disabled extension) should not make every
    // subsequent tool call wait again. Stamp when an attempt *finishes*, since
    // a cold launch can easily exceed the cooldown on its own.
    if (Date.now() - this.lastConnectAttempt < CONNECT_ATTEMPT_COOLDOWN_MS) {
      return Promise.resolve();
    }
    this.connectAttempt = this.tryEnsureExtensionConnection().finally(() => {
      this.lastConnectAttempt = Date.now();
      this.connectAttempt = null;
    });
    return this.connectAttempt;
  }

  private async tryEnsureExtensionConnection(): Promise<void> {
    if (this.isExtensionConnected() || this.stopped) return;

    // A sleeping MV3 service worker may already be on its way back.
    if (await this.waitForExtension(1_500)) return;
    if (this.stopped || !this.isListening()) return;

    if (chromeLaunchDisabled()) {
      await this.waitForExtension(EXTENSION_WAIT_MS);
      return;
    }

    // Check only the browser we would launch: a running Edge/Brave must not
    // stop us opening the Chrome that actually holds the extension.
    const bin = configuredBrowserBin();
    const running = await isBrowserRunning(bin);
    if (running) {
      // Chrome is up; give the extension a chance to wake/reconnect.
      await this.waitForExtension(EXTENSION_WAIT_MS);
      return;
    }

    // The client may have gone away while we were probing processes.
    if (this.stopped || !this.isListening()) return;

    console.error(
      "[dev-tool-mcp] Chrome is not running; launching it so the extension can connect…",
    );
    const result = await launchBrowser();
    if (!result.launched) {
      console.error(
        `[dev-tool-mcp] Could not launch Chrome: ${result.error ?? "unknown error"}. ` +
          "Set DEV_TOOL_MCP_CHROME_BIN to the browser executable, or start Chrome manually.",
      );
      return;
    }
    console.error(
      `[dev-tool-mcp] Launched Chrome (${result.command}); waiting for the extension…`,
    );
    if (await this.waitForExtension(CHROME_START_WAIT_MS)) {
      console.error("[dev-tool-mcp] Chrome extension connected.");
    } else if (!this.stopped) {
      console.error(
        "[dev-tool-mcp] Chrome started but the extension did not connect. " +
          "Make sure dev-tool-mcp is loaded in that profile (chrome://extensions).",
      );
    }
  }

  getState(): BridgeState {
    return getBridgeState();
  }

  getConsoleBuffer(): unknown[] {
    return [...this.consoleBuffer];
  }

  clearConsoleBuffer(): void {
    this.consoleBuffer = [];
  }

  getNetworkBuffer(): unknown[] {
    return [...this.networkBuffer];
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.isListening()) {
      throw Object.assign(
        new Error(
          `Bridge is not listening: port ${this.preferredPort} was unavailable at startup, so the extension cannot reach this instance. Close the other dev-tool-mcp instance (usually another Claude Code session) and restart this one.`,
        ),
        { code: ErrorCodes.EXTENSION_DISCONNECTED },
      );
    }

    if (!this.isExtensionConnected() || !this.socket) {
      // Chrome may simply not be open yet. Launch it (once, throttled) and
      // give the extension time to connect before failing the tool call.
      await this.ensureExtensionConnection();
    }

    if (!this.isExtensionConnected() || !this.socket) {
      const detail =
        this.port === this.preferredPort
          ? "Extension is not connected. Chrome was either not running (and could not be launched) or dev-tool-mcp is not loaded/enabled in Chrome."
          : `Extension is not connected. This instance listens on ${this.port}, not the default ${this.preferredPort}. Reload the extension or wait for discovery to attach this port.`;
      const err = Object.assign(
        new Error(bridgeError(ErrorCodes.EXTENSION_DISCONNECTED, detail).message),
        { code: ErrorCodes.EXTENSION_DISCONNECTED },
      );
      throw err;
    }

    const id = randomUUID();
    const msg: RequestMessage = {
      type: "request",
      id,
      token: this.token,
      method,
      params,
    };

    const effectiveTimeout = isMutatingRpc(method)
      ? timeoutMs + CONTROL_REQUEST_TIMEOUT_MS
      : method === "control.request"
        ? Math.max(timeoutMs, CONTROL_REQUEST_TIMEOUT_MS + 5_000)
        : timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error("Request timed out."), {
            code: ErrorCodes.TIMEOUT,
          }),
        );
      }, effectiveTimeout);

      this.pending.set(id, { resolve, reject, timer });
      const fail = (message: string): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          Object.assign(new Error(message), {
            code: ErrorCodes.EXTENSION_DISCONNECTED,
          }),
        );
      };
      try {
        this.socket!.send(JSON.stringify(msg), (err) => {
          if (err) fail(`Failed to send request: ${err.message}`);
        });
      } catch (err) {
        fail(
          `Failed to send request: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host ?? "";
    if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (req.url === "/health") {
      const body: BridgeHealth = {
        ok: true,
        extensionConnected: this.isExtensionConnected(),
        authorized: this.authorized,
        activePort: this.activePort,
        identity: this.identity,
        state: getBridgeState(),
      };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
      return;
    }

    // The extension announces which bridge it controls. Token-gated so a random
    // page cannot retarget the bridge; localhost-only via the host check above.
    if (req.url === "/control") {
      void this.handleControl(req, res);
      return;
    }

    if (req.url === "/handshake") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          token: this.token,
          port: this.port,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private async handleControl(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 4096) {
          reply(413, { ok: false, error: "Body too large" });
          return;
        }
        chunks.push(chunk as Buffer);
      }

      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        token?: string;
        activePort?: number | null;
      };

      if (parsed.token !== this.token) {
        reply(403, { ok: false, error: "Handshake token mismatch." });
        return;
      }
      if (parsed.activePort !== null && typeof parsed.activePort !== "number") {
        reply(400, { ok: false, error: "activePort (number or null) is required." });
        return;
      }

      const previous = this.activePort;
      this.activePort = parsed.activePort;
      if (previous !== this.activePort) {
        console.error(
          `[dev-tool-mcp] Extension is controlling port ${this.activePort}` +
            (this.authorized ? " (this instance)." : ` (not this instance, ${this.port}).`),
        );
      }
      reply(200, {
        ok: true,
        authorized: this.authorized,
        identity: this.identity,
      });
    } catch {
      reply(400, { ok: false, error: "Invalid JSON body." });
    }
  }

  private onConnection(ws: WebSocket): void {
    // Single extension connection; replace previous.
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = ws;
    markExtensionConnected(true);

    ws.on("message", (data) => {
      void this.onMessage(ws, data.toString());
    });

    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        markExtensionConnected(false);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(
            Object.assign(new Error("Extension disconnected."), {
              code: ErrorCodes.EXTENSION_DISCONNECTED,
            }),
          );
          this.pending.delete(id);
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[dev-tool-mcp] WS error:", err.message);
    });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(raw) as BridgeMessage;
    } catch {
      return;
    }

    if (msg.type === "hello") {
      if (msg.token && msg.token !== this.token) {
        ws.send(
          JSON.stringify({
            type: "response",
            id: "auth",
            ok: false,
            error: bridgeError(ErrorCodes.UNAUTHORIZED, "Handshake token mismatch."),
          } satisfies ResponseMessage),
        );
        ws.close();
        return;
      }
      const welcome: WelcomeMessage = {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        token: this.token,
        port: this.port,
      };
      ws.send(JSON.stringify(welcome));
      markExtensionConnected(true);
      return;
    }

    if (msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(
          Object.assign(new Error(msg.error?.message ?? "Request failed"), {
            code: msg.error?.code ?? ErrorCodes.UNKNOWN,
          }),
        );
      }
      return;
    }

    if (msg.type === "event") {
      this.onEvent(msg);
    }
  }

  private onEvent(msg: EventMessage): void {
    if (msg.event === "state.changed" && msg.payload) {
      applyExtensionState(msg.payload as Partial<BridgeState>);
      return;
    }
    if (msg.event === "console.message" && msg.payload) {
      this.consoleBuffer.push(msg.payload);
      if (this.consoleBuffer.length > 1000) {
        this.consoleBuffer.splice(0, this.consoleBuffer.length - 1000);
      }
      return;
    }
    if (
      (msg.event === "network.request" || msg.event === "network.response") &&
      msg.payload
    ) {
      this.networkBuffer.push(msg.payload);
      if (this.networkBuffer.length > 1000) {
        this.networkBuffer.splice(0, this.networkBuffer.length - 1000);
      }
      return;
    }
    if (msg.event === "debugger.detached") {
      applyExtensionState({
        ...getBridgeState(),
        debuggerAttached: false,
      });
      return;
    }
    if (msg.event === "control.changed" && msg.payload) {
      const payload = msg.payload as ControlChangedPayload;
      this.activePort = payload.controllerPort;
      console.error(
        payload.controllerPort == null
          ? "[dev-tool-mcp] Extension released browser control."
          : payload.controllerPort === this.port
            ? `[dev-tool-mcp] This instance now controls the browser (${payload.reason}).`
            : `[dev-tool-mcp] Extension is controlling port ${payload.controllerPort} (${payload.reason}).`,
      );
    }
  }
}

let bridgeSingleton: WsBridge | null = null;

export function getBridge(): WsBridge {
  if (!bridgeSingleton) {
    throw new Error("WsBridge not initialized");
  }
  return bridgeSingleton;
}

export function setBridge(bridge: WsBridge): void {
  bridgeSingleton = bridge;
}
