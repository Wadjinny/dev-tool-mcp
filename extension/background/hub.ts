import {
  CONTROL_REQUEST_TIMEOUT_MS,
  DEFAULT_WS_PORT,
  ERROR_MESSAGES,
  ErrorCodes,
  PROTOCOL_VERSION,
  bridgeError,
  discoveryPorts,
  instanceLabel,
  isMutatingRpc,
  type BridgeError,
  type BridgeHealth,
  type BridgeIdentity,
  type ControlChangeReason,
  type ControlStatus,
  type RequestMessage,
  type ResponseMessage,
} from "@dev-tool-mcp/shared";

const STORAGE = {
  token: "handshakeToken",
  tokensByPort: "tokensByPort",
  port: "wsPort",
  controllerPort: "controllerPort",
  lastError: "lastError",
  bridgeStatus: "bridgeStatus",
  discovered: "discoveredBridges",
  pendingControlPort: "pendingControlPort",
} as const;

const CONTROL_NOTIFICATION_ID = "dev-tool-mcp-control";

export type DiscoveredBridge = {
  port: number;
  pid: number;
  cwd: string;
  startedAt: number;
  preferredPort: number;
  name: string | null;
  extensionConnected: boolean;
  controlling: boolean;
};

type BridgeConn = {
  port: number;
  socket: WebSocket;
  token: string;
  identity: BridgeIdentity | null;
  dropping: boolean;
};

type GrantWaiter = {
  resolve: () => void;
  reject: (err: BridgeError) => void;
};

type PendingGrant = {
  port: number;
  waiters: GrantWaiter[];
  timer: ReturnType<typeof setTimeout>;
};

type HubHooks = {
  onRequest: (
    msg: RequestMessage,
    ws: WebSocket,
    port: number,
  ) => Promise<void>;
  onConnected: () => Promise<void>;
};

const connections = new Map<number, BridgeConn>();
const reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
const reconnectAttempts = new Map<number, number>();
let lastDiscovered: DiscoveredBridge[] = [];
let pendingGrant: PendingGrant | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let hooks: HubHooks | null = null;

export function setHubHooks(next: HubHooks): void {
  hooks = next;
}

export function initHubListeners(): void {
  chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
    if (id !== CONTROL_NOTIFICATION_ID) return;
    void settleGrant(buttonIndex === 0);
  });
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== CONTROL_NOTIFICATION_ID) return;
    void settleGrant(true);
  });
  chrome.notifications.onClosed.addListener((id, byUser) => {
    if (id !== CONTROL_NOTIFICATION_ID) return;
    if (pendingGrant && byUser) {
      rejectPending(
        bridgeError(
          ErrorCodes.CONTROL_DENIED,
          ERROR_MESSAGES.CONTROL_DENIED,
        ),
      );
    }
  });
}

export async function startHub(): Promise<void> {
  await migrateLegacyToken();
  await chrome.storage.local.remove(STORAGE.pendingControlPort);
  try {
    await chrome.notifications.clear(CONTROL_NOTIFICATION_ID);
  } catch {
    // notifications permission may be pending
  }
  await refreshBridges();
}

export function emitEvent(event: string, payload: unknown): void {
  const raw = JSON.stringify({ type: "event", event, payload });
  for (const conn of connections.values()) {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(raw);
    }
  }
}

export function respond(
  ws: WebSocket,
  id: string,
  ok: boolean,
  result?: unknown,
  error?: BridgeError,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const msg: ResponseMessage = ok
    ? { type: "response", id, ok: true, result }
    : { type: "response", id, ok: false, error };
  ws.send(JSON.stringify(msg));
}

export function anyExtensionConnected(): boolean {
  for (const conn of connections.values()) {
    if (conn.socket.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function summaryBridgeStatus():
  | "connected"
  | "disconnected"
  | "reconnecting" {
  for (const conn of connections.values()) {
    if (conn.socket.readyState === WebSocket.OPEN) return "connected";
  }
  if (reconnectTimers.size > 0 || lastDiscovered.length > 0) return "reconnecting";
  return "disconnected";
}

export async function setLastError(message: string | null): Promise<void> {
  if (message) {
    await chrome.storage.local.set({ [STORAGE.lastError]: message });
  } else {
    await chrome.storage.local.remove(STORAGE.lastError);
  }
}

export async function getControllerPort(): Promise<number | null> {
  const data = await chrome.storage.local.get([
    STORAGE.controllerPort,
    STORAGE.port,
  ]);
  const stored = data[STORAGE.controllerPort];
  if (typeof stored === "number") return stored;
  const legacy = data[STORAGE.port];
  if (typeof legacy === "number") return legacy;
  return null;
}

export async function getTokenForPort(port: number): Promise<string | null> {
  const tokens = await getTokensByPort();
  const token = tokens[String(port)];
  return typeof token === "string" ? token : null;
}

export function pendingControlLabel(): string | null {
  if (!pendingGrant) return null;
  const identity = identityFor(pendingGrant.port);
  return identity
    ? instanceLabel(identity)
    : `:${pendingGrant.port}`;
}

export async function controlStatus(port: number): Promise<ControlStatus> {
  const controllerPort = await getControllerPort();
  return {
    controllerPort,
    controlling: controllerPort === port,
    identity: identityFor(controllerPort),
  };
}

export async function ensureControl(
  port: number,
  method: string,
): Promise<void> {
  if (!isMutatingRpc(method)) return;
  await requestControl(port);
}

export async function requestControl(port: number): Promise<ControlStatus> {
  const current = await getControllerPort();
  if (current === port) return controlStatus(port);
  if (current == null) {
    await grantControl(port, "granted");
    return controlStatus(port);
  }
  await waitForUserGrant(port);
  return controlStatus(port);
}

export async function releaseControl(port: number): Promise<ControlStatus> {
  const current = await getControllerPort();
  if (current !== port) return controlStatus(port);
  await setControllerPort(null);
  await announceControl(lastDiscovered);
  emitEvent("control.changed", {
    controllerPort: null,
    identity: null,
    reason: "released" satisfies ControlChangeReason,
  });
  return controlStatus(port);
}

export async function setManualControl(port: number): Promise<DiscoveredBridge[]> {
  if (pendingGrant) {
    rejectPending(
      bridgeError(ErrorCodes.CONTROL_DENIED, ERROR_MESSAGES.CONTROL_DENIED),
    );
  }
  await grantControl(port, "manual");
  return refreshBridges();
}

export async function refreshBridges(): Promise<DiscoveredBridge[]> {
  const bridges = await discoverBridges();
  await announceControl(bridges);
  await syncConnections(bridges);
  return listBridgesSnapshot();
}

export function listBridgesSnapshot(): DiscoveredBridge[] {
  const controller = lastDiscovered.find((b) => b.controlling)?.port ?? null;
  return lastDiscovered.map((b) => ({
    ...b,
    extensionConnected: isSocketOpen(b.port),
    controlling: controller === b.port,
  }));
}

export async function reconnectAll(): Promise<void> {
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  reconnectAttempts.clear();
  for (const conn of [...connections.values()]) {
    dropConnection(conn.port, true);
  }
  await refreshBridges();
}

function isSocketOpen(port: number): boolean {
  const conn = connections.get(port);
  return conn?.socket.readyState === WebSocket.OPEN;
}

async function migrateLegacyToken(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE.tokensByPort,
    STORAGE.token,
    STORAGE.port,
    STORAGE.controllerPort,
  ]);
  const existing = data[STORAGE.tokensByPort];
  if (existing && typeof existing === "object") return;
  const token = data[STORAGE.token];
  const port = data[STORAGE.controllerPort] ?? data[STORAGE.port];
  if (typeof token === "string" && typeof port === "number") {
    await chrome.storage.local.set({
      [STORAGE.tokensByPort]: { [String(port)]: token },
    });
  }
}

async function getTokensByPort(): Promise<Record<string, string>> {
  const data = await chrome.storage.local.get(STORAGE.tokensByPort);
  const map = data[STORAGE.tokensByPort];
  if (map && typeof map === "object") {
    return map as Record<string, string>;
  }
  return {};
}

async function setTokenForPort(port: number, token: string): Promise<void> {
  const tokens = await getTokensByPort();
  tokens[String(port)] = token;
  await chrome.storage.local.set({ [STORAGE.tokensByPort]: tokens });
}

async function setControllerPort(port: number | null): Promise<void> {
  lastDiscovered = lastDiscovered.map((b) => ({
    ...b,
    controlling: port != null && b.port === port,
  }));
  if (port == null) {
    await chrome.storage.local.remove(STORAGE.controllerPort);
    return;
  }
  await chrome.storage.local.set({
    [STORAGE.controllerPort]: port,
    [STORAGE.port]: port,
  });
}

async function fetchHandshakeToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/handshake`, {
    signal: AbortSignal.timeout(700),
  });
  if (!res.ok) throw new Error(`Handshake HTTP ${res.status}`);
  const data = (await res.json()) as { token: string };
  if (typeof data.token !== "string" || !data.token) {
    throw new Error("Handshake missing token.");
  }
  await setTokenForPort(port, data.token);
  return data.token;
}

async function probeBridgePort(port: number): Promise<DiscoveredBridge | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return null;
    const health = (await res.json()) as BridgeHealth;
    if (!health?.ok || !health.identity) return null;
    return {
      port: health.identity.port,
      pid: health.identity.pid,
      cwd: health.identity.cwd,
      startedAt: health.identity.startedAt,
      preferredPort: health.identity.preferredPort,
      name: health.identity.name ?? null,
      extensionConnected: false,
      controlling: false,
    };
  } catch {
    return null;
  }
}

async function discoverBridges(): Promise<DiscoveredBridge[]> {
  const preferred = (await getControllerPort()) ?? Number(DEFAULT_WS_PORT);
  const results = await Promise.all(
    discoveryPorts(preferred).map((p) => probeBridgePort(p)),
  );
  const controller = await getControllerPort();
  const found = results
    .filter((b): b is DiscoveredBridge => b !== null)
    .map((b) => ({
      ...b,
      controlling: controller != null && b.port === controller,
    }))
    .sort((a, b) => a.port - b.port);
  lastDiscovered = found;
  await chrome.storage.local.set({ [STORAGE.discovered]: found });
  return found;
}

async function announceControl(bridges: DiscoveredBridge[]): Promise<void> {
  const activePort = await getControllerPort();
  await Promise.all(
    bridges.map(async (bridge) => {
      try {
        let token = await getTokenForPort(bridge.port);
        if (!token) token = await fetchHandshakeToken(bridge.port);
        await fetch(`http://127.0.0.1:${bridge.port}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            activePort,
          }),
          signal: AbortSignal.timeout(700),
        });
      } catch {
        // instance went away between scan and announce
      }
    }),
  );
}

async function syncConnections(bridges: DiscoveredBridge[]): Promise<void> {
  const live = new Set(bridges.map((b) => b.port));
  for (const port of [...connections.keys()]) {
    if (!live.has(port)) dropConnection(port, true);
  }
  await Promise.all(
    bridges.map((bridge) => ensureConnection(bridge.port, bridge)),
  );
  refreshPing();
  await persistBridgeStatus();
}

async function persistBridgeStatus(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE.bridgeStatus]: summaryBridgeStatus(),
  });
}

async function ensureConnection(
  port: number,
  bridge?: DiscoveredBridge,
): Promise<void> {
  const existing = connections.get(port);
  if (
    existing &&
    (existing.socket.readyState === WebSocket.OPEN ||
      existing.socket.readyState === WebSocket.CONNECTING)
  ) {
    if (bridge && existing.identity == null) {
      existing.identity = identityFromDiscovered(bridge);
    }
    return;
  }

  let token = await getTokenForPort(port);
  try {
    if (!token) token = await fetchHandshakeToken(port);
  } catch {
    scheduleReconnect(port);
    return;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const conn: BridgeConn = {
    port,
    socket: ws,
    token,
    identity: bridge ? identityFromDiscovered(bridge) : identityFor(port),
    dropping: false,
  };
  const pendingTimer = reconnectTimers.get(port);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    reconnectTimers.delete(port);
  }
  connections.set(port, conn);

  ws.addEventListener("open", () => {
    void (async () => {
      reconnectAttempts.set(port, 0);
      await setLastError(null);
      const latest = await getTokenForPort(port);
      ws.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          role: "extension",
          token: latest ?? token,
        }),
      );
      await persistBridgeStatus();
      refreshPing();
      try {
        await hooks?.onConnected();
      } catch {
        // state push is best-effort
      }
    })();
  });

  ws.addEventListener("message", (ev) => {
    void (async () => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const m = msg as { type?: string };
      if (m.type === "welcome") {
        const w = m as { token: string; port: number };
        await setTokenForPort(port, w.token);
        conn.token = w.token;
        try {
          await hooks?.onConnected();
        } catch {
          // ignore
        }
        void refreshBridges();
        return;
      }
      if (m.type === "request") {
        await hooks?.onRequest(m as RequestMessage, ws, port);
      }
    })();
  });

  ws.addEventListener("close", () => {
    if (connections.get(port)?.socket !== ws) return;
    connections.delete(port);
    void persistBridgeStatus();
    void (async () => {
      const controller = await getControllerPort();
      if (controller === port) {
        await setControllerPort(null);
        emitEvent("control.changed", {
          controllerPort: null,
          identity: null,
          reason: "disconnected" satisfies ControlChangeReason,
        });
        await announceControl(lastDiscovered);
      }
    })();
    if (!conn.dropping) scheduleReconnect(port);
    refreshPing();
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect(port: number): void {
  if (reconnectTimers.has(port)) return;
  const attempt = (reconnectAttempts.get(port) ?? 0) + 1;
  reconnectAttempts.set(port, attempt);
  const delay = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  const timer = setTimeout(() => {
    reconnectTimers.delete(port);
    void ensureConnection(port);
  }, delay);
  reconnectTimers.set(port, timer);
}

function dropConnection(port: number, fromScan: boolean): void {
  const timer = reconnectTimers.get(port);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(port);
  }
  const conn = connections.get(port);
  if (!conn) return;
  conn.dropping = fromScan;
  try {
    conn.socket.close();
  } catch {
    // ignore
  }
  connections.delete(port);
}

function refreshPing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    let any = false;
    for (const conn of connections.values()) {
      if (conn.socket.readyState === WebSocket.OPEN) {
        any = true;
        conn.socket.send(
          JSON.stringify({
            type: "event",
            event: "ping",
            payload: { t: Date.now() },
          }),
        );
      }
    }
    if (!any && pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }, 20_000);
}

function identityFromDiscovered(bridge: DiscoveredBridge): BridgeIdentity {
  return {
    pid: bridge.pid,
    cwd: bridge.cwd,
    startedAt: bridge.startedAt,
    port: bridge.port,
    preferredPort: bridge.preferredPort,
    name: bridge.name,
  };
}

function identityFor(port: number | null): BridgeIdentity | null {
  if (port == null) return null;
  const conn = connections.get(port);
  if (conn?.identity) return conn.identity;
  const cached = lastDiscovered.find((b) => b.port === port);
  return cached ? identityFromDiscovered(cached) : null;
}

async function grantControl(
  port: number,
  reason: ControlChangeReason,
): Promise<void> {
  await setControllerPort(port);
  const identity = identityFor(port);
  emitEvent("control.changed", {
    controllerPort: port,
    identity,
    reason,
  });
  await announceControl(lastDiscovered);
}

function rejectPending(err: BridgeError): void {
  const pending = pendingGrant;
  pendingGrant = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  for (const waiter of pending.waiters) waiter.reject(err);
  void chrome.notifications.clear(CONTROL_NOTIFICATION_ID);
  void chrome.storage.local.remove(STORAGE.pendingControlPort);
}

function resolvePending(): void {
  const pending = pendingGrant;
  pendingGrant = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  for (const waiter of pending.waiters) waiter.resolve();
  void chrome.notifications.clear(CONTROL_NOTIFICATION_ID);
  void chrome.storage.local.remove(STORAGE.pendingControlPort);
}

async function waitForUserGrant(port: number): Promise<void> {
  if (pendingGrant) {
    if (pendingGrant.port !== port) {
      throw bridgeError(
        ErrorCodes.CONTROL_REQUEST_PENDING,
        ERROR_MESSAGES.CONTROL_REQUEST_PENDING,
      );
    }
    await new Promise<void>((resolve, reject) => {
      pendingGrant!.waiters.push({ resolve, reject });
    });
    return;
  }

  const requester = identityFor(port);
  const holder = identityFor(await getControllerPort());
  const requesterLabel = requester
    ? instanceLabel(requester)
    : `:${port}`;
  const holderLabel = holder ? instanceLabel(holder) : "none";

  try {
    await chrome.notifications.create(CONTROL_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "dev-tool-mcp: control request",
      message: `${requesterLabel} wants to drive the browser.\nCurrently: ${holderLabel}`,
      buttons: [{ title: "Allow" }, { title: "Deny" }],
      requireInteraction: true,
      priority: 2,
    });
  } catch (err) {
    throw bridgeError(
      ErrorCodes.UNKNOWN,
      `Failed to show control notification: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await chrome.storage.local.set({ [STORAGE.pendingControlPort]: port });

  await new Promise<void>((resolve, reject) => {
    pendingGrant = {
      port,
      waiters: [{ resolve, reject }],
      timer: setTimeout(() => {
        rejectPending(
          bridgeError(
            ErrorCodes.CONTROL_REQUEST_TIMEOUT,
            ERROR_MESSAGES.CONTROL_REQUEST_TIMEOUT,
          ),
        );
      }, CONTROL_REQUEST_TIMEOUT_MS),
    };
  });
}

async function settleGrant(allow: boolean): Promise<void> {
  const pending = pendingGrant;
  if (!pending) return;
  if (!allow) {
    rejectPending(
      bridgeError(ErrorCodes.CONTROL_DENIED, ERROR_MESSAGES.CONTROL_DENIED),
    );
    return;
  }
  const previous = await getControllerPort();
  const reason: ControlChangeReason =
    previous != null && previous !== pending.port ? "stolen" : "granted";
  await grantControl(pending.port, reason);
  resolvePending();
}
