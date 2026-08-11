import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WS_PORT,
  ErrorCodes,
  PROTOCOL_VERSION,
  bridgeError,
  type BridgeMessage,
  type BridgeState,
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

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: string }) => void;
  timer: NodeJS.Timeout;
};

export class WsBridge {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private consoleBuffer: unknown[] = [];
  private networkBuffer: unknown[] = [];
  readonly port: number;
  readonly token: string;

  constructor(token: string, port = DEFAULT_WS_PORT) {
    this.token = token;
    this.port =
      Number(process.env.DEV_TOOL_MCP_WS_PORT) || port || DEFAULT_WS_PORT;
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: "/",
    });

    this.wss.on("connection", (ws) => this.onConnection(ws));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.port, "127.0.0.1", () => resolve());
    });

    console.error(
      `[dev-tool-mcp] WebSocket bridge listening on ws://127.0.0.1:${this.port}`,
    );
  }

  async stop(): Promise<void> {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("Bridge shutting down"), { code: ErrorCodes.EXTENSION_DISCONNECTED }));
      this.pending.delete(id);
    }
    this.socket?.close();
    this.socket = null;
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer?.close(() => resolve());
    });
  }

  isExtensionConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
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
    if (!this.isExtensionConnected() || !this.socket) {
      const err = Object.assign(
        new Error(bridgeError(ErrorCodes.EXTENSION_DISCONNECTED, "Extension is not connected.").message),
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

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error("Request timed out."), {
            code: ErrorCodes.TIMEOUT,
          }),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify(msg));
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          extensionConnected: this.isExtensionConnected(),
          state: getBridgeState(),
        }),
      );
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
