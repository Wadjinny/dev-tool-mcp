import {
  ErrorCodes,
  bridgeError,
  isCdpMethodAllowed,
  type ConsoleMessage,
  type NetworkEntry,
  type NetworkInitiator,
  type NetworkListFilter,
  type WebSocketMessageEntry,
} from "@dev-tool-mcp/shared";

const DEBUGGER_VERSION = "1.3";
const RING = 1000;
const WS_MSG_RING = 50;
const POST_DATA_LIST_MAX = 2_000;
const POST_DATA_DETAIL_MAX = 100_000;
const WS_DATA_MAX = 4_000;
const WORKER_TYPES = new Set([
  "worker",
  "shared_worker",
  "service_worker",
]);

export type WorkerAttachInfo = {
  targetId: string;
  type: string;
  url: string;
};

export type DebuggerTargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  tabId?: number;
  /** True if this extension has an active debugger session on the target. */
  attached: boolean;
};

export type AttachDebuggerResult = {
  attached: boolean;
  workersAttached: WorkerAttachInfo[];
  workerAttachErrors?: Array<WorkerAttachInfo & { error: string }>;
};

/** Per-tab CDP session: each Connected tab (one per MCP session) has its own buffers. */
type Session = {
  tabId: number;
  attached: boolean;
  bufferStartedAt: number | null;
  consoleBuf: ConsoleMessage[];
  networkMap: Map<string, NetworkEntry>;
  networkOrder: string[];
  /** CDP targetId -> type for worker/iframe attribution. */
  targetTypes: Map<string, string>;
  /** Worker/shared/service worker targets we explicitly chrome.debugger.attach'd. */
  workerIds: Set<string>;
};

const sessions = new Map<number, Session>();
/** Explicitly attached / auto-attached targetId -> owning tabId. */
const targetOwner = new Map<string, number>();

type EventEmitter = (event: string, payload: unknown, tabId: number) => void;
let emitEvent: EventEmitter = () => {};

export function setDebuggerEventEmitter(fn: EventEmitter): void {
  emitEvent = fn;
}

function newSession(tabId: number): Session {
  return {
    tabId,
    attached: false,
    bufferStartedAt: null,
    consoleBuf: [],
    networkMap: new Map(),
    networkOrder: [],
    targetTypes: new Map(),
    workerIds: new Set(),
  };
}

function sessionFor(tabId: number): Session {
  let s = sessions.get(tabId);
  if (!s) {
    s = newSession(tabId);
    sessions.set(tabId, s);
  }
  return s;
}

/** Read-only view; an absent session behaves like an empty, detached one. */
function peekSession(tabId: number): Session {
  return sessions.get(tabId) ?? newSession(tabId);
}

export function isDebuggerAttached(tabId: number): boolean {
  return sessions.get(tabId)?.attached ?? false;
}

export function attachedTabIds(): number[] {
  return [...sessions.values()].filter((s) => s.attached).map((s) => s.tabId);
}

/** Drop all capture state for a tab (tab closed / disconnected). */
export async function forgetTab(tabId: number): Promise<void> {
  if (isDebuggerAttached(tabId)) await detachDebugger(tabId);
  const s = sessions.get(tabId);
  if (s) for (const id of s.targetTypes.keys()) targetOwner.delete(id);
  sessions.delete(tabId);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isRelatedWorkerTarget(
  target: chrome.debugger.TargetInfo,
  tabId: number,
  pageOrigin: string | null,
): boolean {
  if (!WORKER_TYPES.has(target.type)) return false;
  if (target.tabId != null && target.tabId === tabId) return true;
  if (pageOrigin && originOf(target.url) === pageOrigin) return true;
  return false;
}

async function attachExistingWorkers(
  s: Session,
  tabUrl: string,
): Promise<{
  workersAttached: WorkerAttachInfo[];
  workerAttachErrors: Array<WorkerAttachInfo & { error: string }>;
}> {
  const workersAttached: WorkerAttachInfo[] = [];
  const workerAttachErrors: Array<WorkerAttachInfo & { error: string }> = [];
  const pageOrigin = originOf(tabUrl);

  let targets: chrome.debugger.TargetInfo[] = [];
  try {
    targets = await chrome.debugger.getTargets();
  } catch {
    return { workersAttached, workerAttachErrors };
  }

  for (const t of targets) {
    if (!isRelatedWorkerTarget(t, s.tabId, pageOrigin)) continue;
    const owner = targetOwner.get(t.id);
    if (s.workerIds.has(t.id) || (owner != null && owner !== s.tabId)) {
      // Already ours, or a shared worker already captured for another tab.
      workersAttached.push({ targetId: t.id, type: t.type, url: t.url ?? "" });
      continue;
    }

    try {
      // Only track ids we chrome.debugger.attach ourselves so detach
      // does not tear down flatten auto-attach sessions.
      if (!t.attached) {
        await chrome.debugger.attach({ targetId: t.id }, DEBUGGER_VERSION);
        s.workerIds.add(t.id);
      }
      s.targetTypes.set(t.id, t.type);
      targetOwner.set(t.id, s.tabId);
      await sendCdpToTarget(t.id, "Network.enable", {});
      await sendCdpToTarget(t.id, "Runtime.enable", {});
      workersAttached.push({ targetId: t.id, type: t.type, url: t.url ?? "" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      workerAttachErrors.push({
        targetId: t.id,
        type: t.type,
        url: t.url ?? "",
        error: message,
      });
    }
  }

  return { workersAttached, workerAttachErrors };
}

async function detachWorkerTargets(s: Session): Promise<void> {
  const ids = [...s.workerIds];
  s.workerIds.clear();
  for (const id of ids) {
    s.targetTypes.delete(id);
    targetOwner.delete(id);
    try {
      await chrome.debugger.detach({ targetId: id });
    } catch {
      // already detached
    }
  }
}

export async function attachDebugger(
  tabId: number,
): Promise<AttachDebuggerResult> {
  let tabUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url ?? "";
  } catch {
    // ignore
  }

  const s = sessionFor(tabId);
  if (!s.attached) {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // After a service-worker restart Chrome may still hold our session.
      if (!/already attached/i.test(message)) {
        throw bridgeError(
          ErrorCodes.DEBUGGER_ATTACH_FAILED,
          `Failed to attach debugger. Close DevTools on that tab and retry. (${message})`,
        );
      }
    }
    s.attached = true;
    s.bufferStartedAt = Date.now();
    s.targetTypes.set(`tab:${tabId}`, "page");
    try {
      await sendCdp(tabId, "Runtime.enable", {});
      await sendCdp(tabId, "Console.enable", {});
      await sendCdp(tabId, "Network.enable", {});
      await sendCdp(tabId, "Page.enable", {});
      // Auto-attach *new* workers; existing ones are attached below via getTargets.
      await sendCdp(tabId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch {
      // domains may partially fail; keep attach
    }
  }

  const { workersAttached, workerAttachErrors } = await attachExistingWorkers(
    s,
    tabUrl,
  );
  return {
    attached: true,
    workersAttached,
    ...(workerAttachErrors.length ? { workerAttachErrors } : {}),
  };
}

/** Detach CDP from a tab. Buffers are kept (post-mortem reads) until forgetTab. */
export async function detachDebugger(
  tabId: number,
): Promise<{ attached: boolean }> {
  const s = sessions.get(tabId);
  if (!s) return { attached: false };
  await detachWorkerTargets(s);
  const wasAttached = s.attached;
  s.attached = false;
  s.bufferStartedAt = null;
  for (const id of s.targetTypes.keys()) targetOwner.delete(id);
  s.targetTypes.clear();
  if (wasAttached) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
  }
  return { attached: false };
}

export async function listDebuggerTargets(tabId: number): Promise<{
  targets: DebuggerTargetInfo[];
  debuggerAttached: boolean;
}> {
  const s = sessions.get(tabId);
  if (!s?.attached) {
    return { targets: [], debuggerAttached: false };
  }

  let tabUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url ?? "";
  } catch {
    // ignore
  }
  const pageOrigin = originOf(tabUrl);

  const targets: DebuggerTargetInfo[] = [
    {
      targetId: `tab:${tabId}`,
      type: "page",
      url: tabUrl,
      tabId,
      attached: true,
    },
  ];

  try {
    const all = await chrome.debugger.getTargets();
    for (const t of all) {
      if (t.tabId === tabId && t.type === "page") {
        targets[0] = {
          targetId: t.id,
          type: "page",
          url: t.url ?? tabUrl,
          title: t.title,
          tabId: t.tabId,
          attached: true,
        };
        continue;
      }
      if (!isRelatedWorkerTarget(t, tabId, pageOrigin)) continue;
      targets.push({
        targetId: t.id,
        type: t.type,
        url: t.url ?? "",
        title: t.title,
        tabId: t.tabId,
        attached:
          s.workerIds.has(t.id) || s.targetTypes.has(t.id) || !!t.attached,
      });
    }
  } catch {
    // best-effort
  }

  return { targets, debuggerAttached: true };
}

export async function sendCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (!isCdpMethodAllowed(method)) {
    throw bridgeError(
      ErrorCodes.CDP_METHOD_DENIED,
      `CDP method not allowlisted: ${method}`,
    );
  }
  if (!isDebuggerAttached(tabId)) {
    await attachDebugger(tabId);
  }
  return sendCdp(tabId, method, params);
}

async function sendCdp(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw bridgeError(ErrorCodes.DEBUGGER_NOT_ATTACHED, message);
  }
}

async function sendCdpToTarget(
  targetId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await chrome.debugger.sendCommand({ targetId }, method, params);
  } catch {
    return undefined;
  }
}

export function listConsole(
  tabId: number,
  clear?: boolean,
): { messages: ConsoleMessage[] } {
  const s = peekSession(tabId);
  const messages = [...s.consoleBuf];
  if (clear) s.consoleBuf.length = 0;
  return { messages };
}

export function clearConsole(tabId: number): { ok: true } {
  peekSession(tabId).consoleBuf.length = 0;
  return { ok: true };
}

function headersToRecord(
  headers: unknown,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return out;
}

function parseInitiator(raw: unknown): NetworkInitiator | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as {
    type?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    requestId?: string;
  };
  return {
    type: String(i.type ?? "other"),
    url: i.url,
    lineNumber: i.lineNumber,
    columnNumber: i.columnNumber,
    requestId: i.requestId,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function matchesFilter(entry: NetworkEntry, filter: NetworkListFilter): boolean {
  const urlNeedle = (filter.url ?? filter.filter)?.toLowerCase();
  if (urlNeedle && !entry.url.toLowerCase().includes(urlNeedle)) return false;

  if (filter.urlRegex) {
    try {
      if (!new RegExp(filter.urlRegex, "i").test(entry.url)) return false;
    } catch {
      return false;
    }
  }

  if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) {
    return false;
  }

  if (filter.host) {
    try {
      if (new URL(entry.url).host.toLowerCase() !== filter.host.toLowerCase()) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (filter.type && String(entry.type ?? "").toLowerCase() !== filter.type.toLowerCase()) {
    return false;
  }

  if (filter.status != null && entry.status !== filter.status) return false;
  if (filter.statusMin != null && (entry.status ?? -1) < filter.statusMin) return false;
  if (filter.statusMax != null && (entry.status ?? Infinity) > filter.statusMax) {
    return false;
  }

  if (filter.since != null && entry.timestamp < filter.since) return false;

  if (
    filter.resourceKind &&
    (entry.resourceKind ?? "http") !== filter.resourceKind
  ) {
    return false;
  }

  if (
    filter.targetType &&
    String(entry.targetType ?? "page").toLowerCase() !==
      filter.targetType.toLowerCase()
  ) {
    return false;
  }

  return true;
}

function projectEntry(
  entry: NetworkEntry,
  opts: { includeWebSocketMessages?: boolean; detail?: boolean },
): NetworkEntry {
  const postMax = opts.detail ? POST_DATA_DETAIL_MAX : POST_DATA_LIST_MAX;
  const out: NetworkEntry = { ...entry };
  if (out.postData != null) {
    out.postData = truncate(out.postData, postMax);
  }
  if (!opts.includeWebSocketMessages && !opts.detail) {
    if (out.webSocketMessages?.length) {
      out.webSocketMessages = [
        {
          opcode: 1,
          data: `[${out.webSocketMessages.length} frames buffered; pass includeWebSocketMessages or network.get]`,
          direction: "received",
          timestamp: out.timestamp,
        },
      ];
    }
  } else if (out.webSocketMessages) {
    out.webSocketMessages = out.webSocketMessages.map((m) => ({
      ...m,
      data: truncate(m.data, WS_DATA_MAX),
    }));
  }
  return out;
}

export function listNetwork(
  tabId: number,
  filter: NetworkListFilter = {},
): {
  requests: NetworkEntry[];
  bufferStartedAt: number | null;
  debuggerAttached: boolean;
  note?: string;
} {
  const s = peekSession(tabId);
  const { bufferStartedAt } = s;
  let requests = s.networkOrder
    .map((id) => s.networkMap.get(id))
    .filter((x): x is NetworkEntry => !!x)
    .filter((r) => matchesFilter(r, filter));

  if (filter.limit != null) {
    requests = requests.slice(-filter.limit);
  }

  const projected = requests.map((r) =>
    projectEntry(r, {
      includeWebSocketMessages: !!filter.includeWebSocketMessages,
    }),
  );

  const note =
    !s.attached
      ? "Debugger not attached; buffer is inactive until attach."
      : projected.length === 0
        ? `Buffer empty or no matches. Capture starts at attach (bufferStartedAt=${bufferStartedAt}). Existing workers are attached via chrome.debugger.getTargets; new workers via Target.setAutoAttach. Use waitForMs or re-trigger the request.`
        : undefined;

  return {
    requests: projected,
    bufferStartedAt,
    debuggerAttached: s.attached,
    note,
  };
}

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;
const HASHED_ASSET = /^(.+?)[.-]([0-9a-f]{8,}|[A-Za-z0-9_-]{8,}\d[A-Za-z0-9_-]*)\.([a-z0-9]{1,5})$/i;

/**
 * Collapse id-like path segments (numbers, UUIDs, long hex / base64 tokens)
 * to ":id" so "/item/123" and "/item/456" aggregate together.
 */
export function normalizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // keep raw
      }
      if (ID_SEGMENT.test(decoded)) return ":id";
      const asset = HASHED_ASSET.exec(decoded);
      if (asset && /\d/.test(asset[2]!)) return `${asset[1]}.*.${asset[3]}`;
      return seg;
    })
    .join("/");
}

export type NetworkSummary = {
  bufferStartedAt: number | null;
  debuggerAttached: boolean;
  total: number;
  byHost: Array<{ host: string; count: number; lastTimestamp: number }>;
  byTargetType: Record<string, number>;
  topPaths: Array<{
    method: string;
    origin: string;
    pathPrefix: string;
    count: number;
    lastTimestamp: number;
  }>;
  webSockets: Array<{
    url: string;
    id: string;
    messageCount?: number;
    finished?: boolean;
  }>;
};

export function listNetworkSummary(
  tabId: number,
  opts: {
    since?: number;
    limitHosts?: number;
    limitPaths?: number;
  } = {},
): NetworkSummary {
  const s = peekSession(tabId);
  const limitHosts = opts.limitHosts ?? 15;
  const limitPaths = opts.limitPaths ?? 15;
  const entries = s.networkOrder
    .map((id) => s.networkMap.get(id))
    .filter((x): x is NetworkEntry => !!x)
    .filter((r) => (opts.since != null ? r.timestamp >= opts.since : true));

  const hostMap = new Map<string, { count: number; lastTimestamp: number }>();
  const pathMap = new Map<
    string,
    {
      method: string;
      origin: string;
      pathPrefix: string;
      count: number;
      lastTimestamp: number;
    }
  >();
  const byTargetType: Record<string, number> = {};
  const webSockets: NetworkSummary["webSockets"] = [];

  for (const r of entries) {
    const tt = r.targetType ?? "page";
    byTargetType[tt] = (byTargetType[tt] ?? 0) + 1;

    let host = "(invalid)";
    let origin = "";
    let pathPrefix = r.url;
    try {
      const u = new URL(r.url);
      host = u.host;
      origin = u.origin;
      pathPrefix = normalizePath(u.pathname || "/");
    } catch {
      // keep defaults
    }

    const h = hostMap.get(host);
    if (h) {
      h.count += 1;
      if (r.timestamp > h.lastTimestamp) h.lastTimestamp = r.timestamp;
    } else {
      hostMap.set(host, { count: 1, lastTimestamp: r.timestamp });
    }

    const pathKey = `${r.method} ${origin}${pathPrefix}`;
    const p = pathMap.get(pathKey);
    if (p) {
      p.count += 1;
      if (r.timestamp > p.lastTimestamp) p.lastTimestamp = r.timestamp;
    } else {
      pathMap.set(pathKey, {
        method: r.method,
        origin,
        pathPrefix,
        count: 1,
        lastTimestamp: r.timestamp,
      });
    }

    if (r.resourceKind === "websocket" || r.type === "WebSocket") {
      webSockets.push({
        url: r.url,
        id: r.id,
        messageCount: r.webSocketMessages?.length,
        finished: r.finished,
      });
    }
  }

  const byHost = [...hostMap.entries()]
    .map(([host, v]) => ({ host, ...v }))
    .sort((a, b) => b.count - a.count || b.lastTimestamp - a.lastTimestamp)
    .slice(0, limitHosts);

  const topPaths = [...pathMap.values()]
    .sort((a, b) => b.count - a.count || b.lastTimestamp - a.lastTimestamp)
    .slice(0, limitPaths);

  return {
    bufferStartedAt: s.bufferStartedAt,
    debuggerAttached: s.attached,
    total: entries.length,
    byHost,
    byTargetType,
    topPaths,
    webSockets,
  };
}

export function getNetworkEntry(
  tabId: number,
  requestId: string,
): {
  request: NetworkEntry | null;
  bufferStartedAt: number | null;
} {
  const s = peekSession(tabId);
  const { bufferStartedAt } = s;
  const entry = s.networkMap.get(requestId) ?? null;
  return {
    request: entry
      ? projectEntry(entry, {
          includeWebSocketMessages: true,
          detail: true,
        })
      : null,
    bufferStartedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForNetwork(
  tabId: number,
  filter: NetworkListFilter,
  waitForMs: number,
): Promise<{
  requests: NetworkEntry[];
  bufferStartedAt: number | null;
  debuggerAttached: boolean;
  timedOut: boolean;
  note?: string;
}> {
  const since = filter.since ?? Date.now();
  const effective: NetworkListFilter = { ...filter, since };
  const deadline = Date.now() + Math.max(0, waitForMs);

  while (Date.now() <= deadline) {
    const listed = listNetwork(tabId, effective);
    if (listed.requests.length > 0) {
      return { ...listed, timedOut: false };
    }
    await sleep(150);
  }

  const listed = listNetwork(tabId, effective);
  return {
    ...listed,
    timedOut: true,
    note:
      listed.note ??
      `Timed out after ${waitForMs}ms waiting for a matching request (since=${since}).`,
  };
}

export async function getResponseBody(
  tabId: number,
  requestId: string,
): Promise<{ body: string; base64Encoded: boolean }> {
  if (!isDebuggerAttached(tabId)) {
    await attachDebugger(tabId);
  }
  const result = (await sendCdp(tabId, "Network.getResponseBody", {
    requestId,
  })) as { body: string; base64Encoded: boolean };
  return result;
}

function resolveTargetMeta(
  s: Session,
  source: chrome.debugger.Debuggee,
): {
  targetId?: string;
  targetType: string;
} {
  if (source.targetId) {
    return {
      targetId: source.targetId,
      targetType: s.targetTypes.get(source.targetId) ?? "other",
    };
  }
  if (source.tabId != null) {
    return {
      targetId: `tab:${source.tabId}`,
      targetType: "page",
    };
  }
  return { targetType: "page" };
}

function upsertNetwork(s: Session, entry: NetworkEntry): void {
  const isNew = !s.networkMap.has(entry.id);
  s.networkMap.set(entry.id, entry);
  if (isNew) {
    s.networkOrder.push(entry.id);
    trimNetwork(s);
  }
}

function pushWsMessage(
  s: Session,
  requestId: string,
  msg: WebSocketMessageEntry,
): void {
  const prev = s.networkMap.get(requestId);
  if (!prev) return;
  const messages = [...(prev.webSocketMessages ?? []), msg];
  while (messages.length > WS_MSG_RING) messages.shift();
  s.networkMap.set(requestId, { ...prev, webSocketMessages: messages });
}

async function handleAttachedToTarget(
  s: Session,
  source: chrome.debugger.Debuggee,
  p: Record<string, unknown>,
): Promise<void> {
  const info = p.targetInfo as
    | { targetId?: string; type?: string; url?: string }
    | undefined;
  const targetId = info?.targetId;
  const type = String(info?.type ?? "other");
  if (targetId) {
    s.targetTypes.set(targetId, type);
    targetOwner.set(targetId, s.tabId);
  }

  const waiting = !!p.waitingForDebugger;
  const tabId = source.tabId ?? s.tabId;

  // Prefer targetId commands for workers; fall back to tab session (flatten).
  if (targetId && /worker/i.test(type)) {
    // Flatten auto-attach: enable Network on the nested session (no separate attach).
    await sendCdpToTarget(targetId, "Network.enable", {});
    await sendCdpToTarget(targetId, "Runtime.enable", {});
    if (waiting) {
      await sendCdpToTarget(targetId, "Runtime.runIfWaitingForDebugger", {});
    }
  } else if (tabId != null && waiting) {
    try {
      await sendCdp(tabId, "Runtime.runIfWaitingForDebugger", {});
    } catch {
      // ignore
    }
  }
}

function sessionForSource(source: chrome.debugger.Debuggee): Session | null {
  if (source.tabId != null) {
    const s = sessions.get(source.tabId);
    return s?.attached ? s : null;
  }
  if (source.targetId) {
    const owner = targetOwner.get(source.targetId);
    if (owner == null) return null;
    const s = sessions.get(owner);
    return s?.attached ? s : null;
  }
  return null;
}

export function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): void {
  const s = sessionForSource(source);
  if (!s) return;
  const emit = (event: string, payload: unknown) =>
    emitEvent(event, payload, s.tabId);

  const p = params ?? {};
  const { targetId, targetType } = resolveTargetMeta(s, source);

  if (method === "Target.attachedToTarget") {
    void handleAttachedToTarget(s, source, p);
    return;
  }

  if (method === "Target.detachedFromTarget") {
    const id = String(p.targetId ?? source.targetId ?? "");
    if (id) {
      s.targetTypes.delete(id);
      targetOwner.delete(id);
    }
    return;
  }

  if (method === "Console.messageAdded") {
    const m = p.message as {
      level?: string;
      text?: string;
      url?: string;
      line?: number;
      timestamp?: number;
    };
    const entry: ConsoleMessage = {
      level: m.level ?? "log",
      text: m.text ?? "",
      url: m.url,
      lineNumber: m.line,
      timestamp: m.timestamp ?? Date.now(),
    };
    pushRing(s.consoleBuf, entry);
    emit("console.message", entry);
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
    const text = args
      .map((a) =>
        a.value !== undefined
          ? String(a.value)
          : (a.description ?? "[object]"),
      )
      .join(" ");
    const entry: ConsoleMessage = {
      level: String(p.type ?? "log"),
      text,
      timestamp: Number(p.timestamp ?? Date.now()),
    };
    pushRing(s.consoleBuf, entry);
    emit("console.message", entry);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const requestId = String(p.requestId ?? "");
    const request = p.request as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    };
    const prev = s.networkMap.get(requestId);
    const entry: NetworkEntry = {
      id: requestId,
      url: request?.url ?? prev?.url ?? "",
      method: request?.method ?? prev?.method ?? "GET",
      type: String(p.type ?? prev?.type ?? ""),
      timestamp: prev?.timestamp ?? Date.now(),
      requestHeaders: headersToRecord(request?.headers) ?? prev?.requestHeaders,
      postData:
        request?.postData != null
          ? truncate(String(request.postData), POST_DATA_DETAIL_MAX)
          : prev?.postData,
      initiator: parseInitiator(p.initiator) ?? prev?.initiator,
      targetId: targetId ?? prev?.targetId,
      targetType: targetType ?? prev?.targetType,
      resourceKind: prev?.resourceKind ?? "http",
      status: prev?.status,
      mimeType: prev?.mimeType,
      responseHeaders: prev?.responseHeaders,
      fromCache: prev?.fromCache,
      webSocketMessages: prev?.webSocketMessages,
    };
    upsertNetwork(s, entry);
    emit("network.request", projectEntry(entry, {}));
    return;
  }

  if (method === "Network.requestServedFromCache") {
    const requestId = String(p.requestId ?? "");
    const prev = s.networkMap.get(requestId);
    if (!prev) return;
    const entry: NetworkEntry = { ...prev, fromCache: true };
    upsertNetwork(s, entry);
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = String(p.requestId ?? "");
    const response = p.response as {
      status?: number;
      mimeType?: string;
      url?: string;
      headers?: Record<string, string>;
      fromDiskCache?: boolean;
      fromPrefetchCache?: boolean;
      fromServiceWorker?: boolean;
      serviceWorkerResponseSource?: string;
      protocol?: string;
      remoteIPAddress?: string;
      encodedDataLength?: number;
    };
    const prev = s.networkMap.get(requestId);
    const entry: NetworkEntry = {
      id: requestId,
      url: response?.url ?? prev?.url ?? "",
      method: prev?.method ?? "GET",
      status: response?.status,
      mimeType: response?.mimeType,
      type: String(p.type ?? prev?.type ?? ""),
      timestamp: prev?.timestamp ?? Date.now(),
      requestHeaders: prev?.requestHeaders,
      responseHeaders:
        headersToRecord(response?.headers) ?? prev?.responseHeaders,
      postData: prev?.postData,
      initiator: prev?.initiator,
      fromCache:
        prev?.fromCache ||
        !!response?.fromDiskCache ||
        !!response?.fromPrefetchCache,
      serviceWorkerResponseSource:
        response?.serviceWorkerResponseSource ??
        (response?.fromServiceWorker ? "service-worker" : undefined),
      encodedDataLength: response?.encodedDataLength ?? prev?.encodedDataLength,
      protocol: response?.protocol ?? prev?.protocol,
      remoteIPAddress: response?.remoteIPAddress ?? prev?.remoteIPAddress,
      targetId: prev?.targetId ?? targetId,
      targetType: prev?.targetType ?? targetType,
      resourceKind: prev?.resourceKind ?? "http",
      webSocketMessages: prev?.webSocketMessages,
      errorText: prev?.errorText,
      finished: prev?.finished,
    };
    upsertNetwork(s, entry);
    emit("network.response", projectEntry(entry, {}));
    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = String(p.requestId ?? "");
    const prev = s.networkMap.get(requestId);
    if (!prev) return;
    const entry: NetworkEntry = {
      ...prev,
      finished: true,
      encodedDataLength:
        typeof p.encodedDataLength === "number"
          ? p.encodedDataLength
          : prev.encodedDataLength,
    };
    upsertNetwork(s, entry);
    return;
  }

  if (method === "Network.loadingFailed") {
    const requestId = String(p.requestId ?? "");
    const prev = s.networkMap.get(requestId);
    const entry: NetworkEntry = {
      id: requestId,
      url: prev?.url ?? "",
      method: prev?.method ?? "GET",
      type: String(p.type ?? prev?.type ?? ""),
      timestamp: prev?.timestamp ?? Date.now(),
      requestHeaders: prev?.requestHeaders,
      postData: prev?.postData,
      initiator: prev?.initiator,
      targetId: prev?.targetId ?? targetId,
      targetType: prev?.targetType ?? targetType,
      resourceKind: prev?.resourceKind ?? "http",
      errorText: String(p.errorText ?? "failed"),
      finished: true,
      fromCache: prev?.fromCache,
      webSocketMessages: prev?.webSocketMessages,
    };
    upsertNetwork(s, entry);
    emit("network.response", projectEntry(entry, {}));
    return;
  }

  if (method === "Network.webSocketCreated") {
    const requestId = String(p.requestId ?? "");
    const entry: NetworkEntry = {
      id: requestId,
      url: String(p.url ?? ""),
      method: "GET",
      type: "WebSocket",
      timestamp: Date.now(),
      initiator: parseInitiator(p.initiator),
      targetId,
      targetType,
      resourceKind: "websocket",
      webSocketMessages: [],
    };
    upsertNetwork(s, entry);
    emit("network.request", projectEntry(entry, {}));
    return;
  }

  if (method === "Network.webSocketWillSendHandshakeRequest") {
    const requestId = String(p.requestId ?? "");
    const request = p.request as { headers?: Record<string, string> };
    const prev = s.networkMap.get(requestId);
    if (!prev) return;
    upsertNetwork(s, {
      ...prev,
      requestHeaders: headersToRecord(request?.headers) ?? prev.requestHeaders,
      resourceKind: "websocket",
      type: "WebSocket",
    });
    return;
  }

  if (method === "Network.webSocketHandshakeResponseReceived") {
    const requestId = String(p.requestId ?? "");
    const response = p.response as {
      status?: number;
      headers?: Record<string, string>;
    };
    const prev = s.networkMap.get(requestId);
    if (!prev) return;
    const entry: NetworkEntry = {
      ...prev,
      status: response?.status ?? prev.status,
      responseHeaders:
        headersToRecord(response?.headers) ?? prev.responseHeaders,
      resourceKind: "websocket",
      type: "WebSocket",
    };
    upsertNetwork(s, entry);
    emit("network.response", projectEntry(entry, {}));
    return;
  }

  if (
    method === "Network.webSocketFrameSent" ||
    method === "Network.webSocketFrameReceived"
  ) {
    const requestId = String(p.requestId ?? "");
    const response = p.response as {
      opcode?: number;
      payloadData?: string;
    };
    pushWsMessage(s, requestId, {
      opcode: Number(response?.opcode ?? 1),
      data: truncate(String(response?.payloadData ?? ""), WS_DATA_MAX),
      direction: method.endsWith("Sent") ? "sent" : "received",
      timestamp: Date.now(),
    });
    return;
  }

  if (method === "Network.webSocketClosed") {
    const requestId = String(p.requestId ?? "");
    const prev = s.networkMap.get(requestId);
    if (!prev) return;
    upsertNetwork(s, { ...prev, finished: true, resourceKind: "websocket" });
  }
}

export function handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.targetId) {
    const owner = targetOwner.get(source.targetId);
    targetOwner.delete(source.targetId);
    const s = owner != null ? sessions.get(owner) : undefined;
    if (s) {
      s.workerIds.delete(source.targetId);
      s.targetTypes.delete(source.targetId);
    }
    return;
  }
  if (source.tabId == null) return;
  const s = sessions.get(source.tabId);
  if (!s?.attached) return;
  s.attached = false;
  s.bufferStartedAt = null;
  // Best-effort cleanup of explicit worker sessions (async).
  void detachWorkerTargets(s);
  for (const id of s.targetTypes.keys()) targetOwner.delete(id);
  s.targetTypes.clear();
  emitEvent("debugger.detached", { tabId: s.tabId }, s.tabId);
}

function pushRing<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > RING) buf.splice(0, buf.length - RING);
}

function trimNetwork(s: Session): void {
  while (s.networkOrder.length > RING) {
    const id = s.networkOrder.shift();
    if (id) s.networkMap.delete(id);
  }
}
