import {
  DEFAULT_WS_PORT,
  ErrorCodes,
  PICK_ELEMENT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  bridgeError,
  type BridgeError,
  type BridgeState,
  type NetworkListFilter,
  type RequestMessage,
  type ResponseMessage,
} from "@dev-tool-mcp/shared";
import {
  attachDebugger,
  clearConsole,
  detachDebugger,
  getAttachedTabId,
  getNetworkEntry,
  getResponseBody,
  handleDebuggerDetach,
  handleDebuggerEvent,
  isDebuggerAttached,
  listConsole,
  listDebuggerTargets,
  listNetwork,
  listNetworkSummary,
  sendCommand,
  setDebuggerEventEmitter,
  waitForNetwork,
} from "./debugger.js";
import {
  allocatePinId,
  armNextKeepPick,
  beginPickSession,
  cancelPick,
  clearPins,
  completePick,
  getPin,
  isActivePick,
  listPins,
  pinCount,
  resetPinsForTabChange,
  type PickPayload,
} from "./pins.js";
import {
  buildState,
  connectTab,
  disconnectTab,
  getConnectedTabId,
  isRestrictedUrl,
  listTabs,
  requireConnectedTab,
  setConnectedTabId,
  updateBadge,
  waitForLoad,
} from "./tabs.js";

const STORAGE = {
  token: "handshakeToken",
  port: "wsPort",
  lastError: "lastError",
  bridgeStatus: "bridgeStatus",
} as const;

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let intentionalClose = false;

async function getPort(): Promise<number> {
  const data = await chrome.storage.local.get(STORAGE.port);
  const port = data[STORAGE.port];
  return typeof port === "number" ? port : Number(DEFAULT_WS_PORT);
}

async function getToken(): Promise<string | null> {
  const data = await chrome.storage.local.get(STORAGE.token);
  const token = data[STORAGE.token];
  return typeof token === "string" ? token : null;
}

async function setLastError(message: string | null): Promise<void> {
  if (message) {
    await chrome.storage.local.set({ [STORAGE.lastError]: message });
  } else {
    await chrome.storage.local.remove(STORAGE.lastError);
  }
}

async function setBridgeStatus(
  status: "connected" | "disconnected" | "reconnecting",
): Promise<void> {
  await chrome.storage.local.set({ [STORAGE.bridgeStatus]: status });
}

async function fetchHandshake(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/handshake`);
  if (!res.ok) throw new Error(`Handshake HTTP ${res.status}`);
  const data = (await res.json()) as { token: string };
  await chrome.storage.local.set({
    [STORAGE.token]: data.token,
    [STORAGE.port]: port,
  });
  return data.token;
}

function emitEvent(event: string, payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "event", event, payload }));
  }
}

setDebuggerEventEmitter(emitEvent);

async function currentState(): Promise<BridgeState> {
  const base = await buildState(socket?.readyState === WebSocket.OPEN);
  const tabId = await getConnectedTabId();
  return {
    ...base,
    debuggerAttached:
      tabId != null ? isDebuggerAttached(tabId) : isDebuggerAttached(),
  };
}

async function pushState(): Promise<void> {
  emitEvent("state.changed", await currentState());
}

type PageFrame = {
  frameId: number;
  parentFrameId: number;
  url: string;
  name: string;
};

async function listPageFrames(tabId: number): Promise<PageFrame[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames?.length) {
      return [{ frameId: 0, parentFrameId: -1, url: "", name: "" }];
    }
    return frames
      .map((f) => ({
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url ?? "",
        name: "",
      }))
      .sort((a, b) => a.frameId - b.frameId);
  } catch {
    return [{ frameId: 0, parentFrameId: -1, url: "", name: "" }];
  }
}

/** Parse snapshot refs: `e3` (main) or `f1842.e3` (iframe). */
function parseRef(ref: string): { frameId: number; localRef: string } {
  const m = /^f(\d+)\.(e\d+)$/.exec(ref);
  if (m) {
    return { frameId: Number(m[1]), localRef: m[2]! };
  }
  if (/^e\d+$/.test(ref)) {
    return { frameId: 0, localRef: ref };
  }
  // Unknown shape — treat as main-frame local ref for backward compat.
  return { frameId: 0, localRef: ref };
}

function qualifyRef(frameId: number, localRef: string): string {
  return frameId === 0 ? localRef : `f${frameId}.${localRef}`;
}

async function resolveFrameSelector(
  tabId: number,
  frame: number | string,
): Promise<number> {
  const frames = await listPageFrames(tabId);
  if (typeof frame === "number" && Number.isFinite(frame)) {
    if (!frames.some((f) => f.frameId === frame)) {
      throw bridgeError(
        ErrorCodes.INVALID_REF,
        `Unknown frameId: ${frame}. Use browser_snapshot frames list.`,
      );
    }
    return frame;
  }
  const q = String(frame).toLowerCase();
  const matches = frames.filter(
    (f) =>
      f.url.toLowerCase().includes(q) ||
      (f.name && f.name.toLowerCase().includes(q)),
  );
  if (!matches.length) {
    throw bridgeError(
      ErrorCodes.INVALID_REF,
      `No frame matching ${JSON.stringify(frame)}. Known: ${frames
        .map((f) => `${f.frameId}:${f.url || "(empty)"}`)
        .join(", ")}`,
    );
  }
  // Prefer exact URL/name, then child frames (avoid matching the shell tab URL first).
  const exact = matches.find(
    (f) => f.url.toLowerCase() === q || (f.name && f.name.toLowerCase() === q),
  );
  if (exact) return exact.frameId;
  const child = matches.find((f) => f.frameId !== 0);
  if (child) return child.frameId;
  return matches[0]!.frameId;
}

async function ensureContentScript(tabId: number): Promise<void> {
  const frames = await listPageFrames(tabId);
  let needsInject = frames.length === 0;
  for (const f of frames) {
    try {
      const ping = (await chrome.tabs.sendMessage(
        tabId,
        {
          channel: "dev-tool-mcp",
          action: "ping",
          params: {},
        },
        { frameId: f.frameId },
      )) as { ok?: boolean } | undefined;
      if (!ping?.ok) {
        needsInject = true;
        break;
      }
    } catch {
      needsInject = true;
      break;
    }
  }
  if (!needsInject) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/automation.js"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw bridgeError(
      ErrorCodes.CONTENT_SCRIPT_FAILED,
      `Failed to inject content script: ${message}`,
    );
  }
}

function withPinTarget(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof params.pin === "string") {
    const pin = getPin(params.pin);
    if (!pin) {
      throw bridgeError(
        ErrorCodes.INVALID_PIN,
        `Unknown pin: ${params.pin}`,
      );
    }
    return { ...params, selector: pin.selector };
  }
  return params;
}

function networkFilterFromParams(
  params: Record<string, unknown>,
): NetworkListFilter {
  const filter: NetworkListFilter = {};
  if (typeof params.filter === "string") filter.filter = params.filter;
  if (typeof params.url === "string") filter.url = params.url;
  if (typeof params.urlRegex === "string") filter.urlRegex = params.urlRegex;
  if (typeof params.method === "string") filter.method = params.method;
  if (typeof params.host === "string") filter.host = params.host;
  if (typeof params.type === "string") filter.type = params.type;
  if (typeof params.status === "number") filter.status = params.status;
  if (typeof params.statusMin === "number") filter.statusMin = params.statusMin;
  if (typeof params.statusMax === "number") filter.statusMax = params.statusMax;
  if (typeof params.since === "number") filter.since = params.since;
  if (params.resourceKind === "http" || params.resourceKind === "websocket") {
    filter.resourceKind = params.resourceKind;
  }
  if (typeof params.targetType === "string") {
    filter.targetType = params.targetType;
  }
  if (typeof params.limit === "number") filter.limit = params.limit;
  if (typeof params.includeWebSocketMessages === "boolean") {
    filter.includeWebSocketMessages = params.includeWebSocketMessages;
  }
  if (typeof params.waitForMs === "number") filter.waitForMs = params.waitForMs;
  return filter;
}

function isUnsafeEvalCspError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("unsafe-eval") ||
    m.includes("content security policy") ||
    (m.includes("evaluating a string as javascript") && m.includes("csp"))
  );
}

function formatEvaluateError(message: string, world: string): string {
  if (isUnsafeEvalCspError(message)) {
    return `Evaluate failed in ${world} world due to Content Security Policy (unsafe-eval blocked). Use world:"main" (CDP Runtime.evaluate) or rely on automatic CSP fallback. Details: ${message}`;
  }
  return message;
}

function withDragTargets(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  if (typeof params.startPin === "string") {
    const pin = getPin(params.startPin);
    if (!pin) {
      throw bridgeError(
        ErrorCodes.INVALID_PIN,
        `Unknown pin: ${params.startPin}`,
      );
    }
    out.startSelector = pin.selector;
  }
  if (typeof params.endPin === "string") {
    const pin = getPin(params.endPin);
    if (!pin) {
      throw bridgeError(
        ErrorCodes.INVALID_PIN,
        `Unknown pin: ${params.endPin}`,
      );
    }
    out.endSelector = pin.selector;
  }
  return out;
}

async function syncPinsToTab(tabId: number): Promise<void> {
  try {
    await pageAction(tabId, "pins.sync", {
      pins: listPins().map((p) => ({
        id: p.id,
        tag: p.tag,
        role: p.role,
        name: p.name,
        selector: p.selector,
      })),
    });
  } catch {
    // content may be gone
  }
}

async function clearPinsAndLocal(tabId: number | null): Promise<void> {
  resetPinsForTabChange();
  if (tabId == null) return;
  try {
    await pageAction(tabId, "pins.clearLocal", {});
  } catch {
    // content may be gone
  }
}

async function startPickerOnTab(
  tabId: number,
  opts: { prompt?: string; wait: boolean; timeoutMs?: number },
): Promise<unknown> {
  const pinId = allocatePinId();
  const timeoutMs = opts.timeoutMs ?? PICK_ELEMENT_TIMEOUT_MS;
  const waitPromise = beginPickSession({
    tabId,
    pinId,
    wait: opts.wait,
    timeoutMs,
  });
  try {
    await pageAction(tabId, "pickerStart", {
      pinId,
      prompt: opts.prompt,
    });
  } catch (err) {
    cancelPick("PICK_CANCELLED");
    throw err;
  }
  if (!opts.wait) {
    setTimeout(() => {
      void (async () => {
        if (!isActivePick(pinId)) return;
        try {
          await pageAction(tabId, "pickerCancel", {});
        } catch {
          // ignore
        }
        if (isActivePick(pinId)) cancelPick("PICK_CANCELLED");
      })();
    }, timeoutMs);
    return { ok: true, pinId, active: true };
  }
  try {
    return await waitPromise;
  } catch (err) {
    try {
      await pageAction(tabId, "pickerCancel", {});
    } catch {
      // ignore
    }
    throw err;
  }
}

async function pageAction(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
  frameId = 0,
): Promise<unknown> {
  await ensureContentScript(tabId);
  const message = {
    channel: "dev-tool-mcp",
    action,
    params,
  };
  let response:
    | { ok: true; result: unknown }
    | { ok: false; error: BridgeError }
    | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, message, {
      frameId,
    })) as typeof response;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/automation.js"],
    });
    response = (await chrome.tabs.sendMessage(tabId, message, {
      frameId,
    })) as typeof response;
  }

  if (!response) {
    throw bridgeError(
      ErrorCodes.CONTENT_SCRIPT_FAILED,
      `No response from content script (frame ${frameId}).`,
    );
  }
  if (!response.ok) {
    throw response.error;
  }
  return response.result;
}

type FrameSnapshot = {
  snapshot: string;
  refs: Record<string, { role: string; name: string; tag: string }>;
};

async function snapshotAllFrames(
  tabId: number,
  interestingOnly: boolean,
): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name: string; tag: string }>;
  frames: Array<{
    frameId: number;
    parentFrameId: number;
    url: string;
    name: string;
    refCount: number;
  }>;
  warning?: string;
}> {
  const pageFrames = await listPageFrames(tabId);
  await ensureContentScript(tabId);

  const lines: string[] = [];
  const refs: Record<string, { role: string; name: string; tag: string }> = {};
  const framesMeta: Array<{
    frameId: number;
    parentFrameId: number;
    url: string;
    name: string;
    refCount: number;
  }> = [];

  let mainRefCount = 0;
  let childRefCount = 0;

  for (const f of pageFrames) {
    let local: FrameSnapshot | null = null;
    try {
      local = (await pageAction(tabId, "snapshot", { interestingOnly }, f.frameId)) as FrameSnapshot;
    } catch {
      framesMeta.push({
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url,
        name: f.name,
        refCount: 0,
      });
      continue;
    }

    const localRefs = local.refs ?? {};
    const refCount = Object.keys(localRefs).length;
    framesMeta.push({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url,
      name: f.name,
      refCount,
    });
    if (f.frameId === 0) mainRefCount = refCount;
    else childRefCount += refCount;

    if (f.frameId === 0) {
      lines.push(local.snapshot || "- document:");
    } else {
      const label = f.name || f.url || `frame ${f.frameId}`;
      lines.push(`- iframe [frameId=${f.frameId}] "${label.replace(/"/g, '\\"')}":`);
      for (const line of (local.snapshot || "").split("\n")) {
        if (!line || line === "- document:") continue;
        // Re-indent under iframe and qualify refs.
        const rewritten = line.replace(/\[ref=(e\d+)\]/g, (_m, localRef: string) => {
          return `[ref=${qualifyRef(f.frameId, localRef)}]`;
        });
        lines.push(`  ${rewritten}`);
      }
    }

    for (const [localRef, meta] of Object.entries(localRefs)) {
      refs[qualifyRef(f.frameId, localRef)] = meta;
    }
  }

  let warning: string | undefined;
  if (mainRefCount <= 8 && childRefCount > 0) {
    warning =
      "Main frame looks like chrome/shell only; most interactive content is in iframes. Use f{frameId}.eN refs from iframe sections below.";
  }

  return {
    snapshot: lines.join("\n"),
    refs,
    frames: framesMeta,
    ...(warning ? { warning } : {}),
  };
}

type LocalFindResult = {
  matches: Array<{
    ref: string;
    role: string;
    name: string;
    tag: string;
    text: string;
  }>;
};

async function findAllFrames(
  tabId: number,
  query: string,
  limit: number,
): Promise<{
  matches: Array<{
    ref: string;
    role: string;
    name: string;
    tag: string;
    text: string;
    frameId: number;
    frameUrl: string;
  }>;
  frames: Array<{ frameId: number; url: string }>;
}> {
  const pageFrames = await listPageFrames(tabId);
  await ensureContentScript(tabId);
  const matches: Array<{
    ref: string;
    role: string;
    name: string;
    tag: string;
    text: string;
    frameId: number;
    frameUrl: string;
  }> = [];

  for (const f of pageFrames) {
    if (matches.length >= limit) break;
    let local: LocalFindResult | null = null;
    try {
      local = (await pageAction(
        tabId,
        "find",
        { query, limit: limit - matches.length },
        f.frameId,
      )) as LocalFindResult;
    } catch {
      continue;
    }
    for (const m of local.matches ?? []) {
      matches.push({
        ...m,
        ref: qualifyRef(f.frameId, m.ref),
        frameId: f.frameId,
        frameUrl: f.url,
      });
      if (matches.length >= limit) break;
    }
  }

  return {
    matches,
    frames: pageFrames.map((f) => ({ frameId: f.frameId, url: f.url })),
  };
}

/** Strip frame prefix from ref/startRef/endRef params and return target frameId. */
function withFrameLocalRefs(
  params: Record<string, unknown>,
): { params: Record<string, unknown>; frameId: number } {
  const out: Record<string, unknown> = { ...params };
  let frameId = 0;
  let sawRef = false;

  const apply = (key: string) => {
    if (typeof out[key] !== "string") return;
    const parsed = parseRef(out[key] as string);
    out[key] = parsed.localRef;
    if (!sawRef) {
      frameId = parsed.frameId;
      sawRef = true;
    } else if (parsed.frameId !== frameId) {
      throw bridgeError(
        ErrorCodes.INVALID_REF,
        "Cross-frame refs are not supported for this action; keep start/end in the same frame.",
      );
    }
  };

  apply("ref");
  apply("startRef");
  apply("endRef");
  return { params: out, frameId };
}

async function cdpFrameIdForChromeFrame(
  tabId: number,
  chromeFrameId: number,
): Promise<string> {
  const pageFrames = await listPageFrames(tabId);
  const target = pageFrames.find((f) => f.frameId === chromeFrameId);
  if (!target) {
    throw bridgeError(
      ErrorCodes.INVALID_REF,
      `Unknown Chrome frameId: ${chromeFrameId}`,
    );
  }

  const tree = (await sendCommand(tabId, "Page.getFrameTree", {})) as {
    frameTree: {
      frame: { id: string; url: string; name?: string };
      childFrames?: unknown[];
    };
  };

  type TreeNode = {
    frame: { id: string; url: string; name?: string };
    childFrames?: TreeNode[];
  };

  const flat: Array<{ id: string; url: string; name: string }> = [];
  const walk = (node: TreeNode) => {
    flat.push({
      id: node.frame.id,
      url: node.frame.url ?? "",
      name: node.frame.name ?? "",
    });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(tree.frameTree as TreeNode);

  if (chromeFrameId === 0) {
    return tree.frameTree.frame.id;
  }

  // Prefer exact URL match; fall back to unique substring.
  const exact = flat.filter((f) => f.url && f.url === target.url);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) {
    const byName = exact.find(
      (f) => target.name && f.name && f.name === target.name,
    );
    if (byName) return byName.id;
  }
  const partial = flat.filter(
    (f) => target.url && f.url && (f.url.includes(target.url) || target.url.includes(f.url)),
  );
  if (partial.length === 1) return partial[0]!.id;

  throw bridgeError(
    ErrorCodes.CONTENT_SCRIPT_FAILED,
    `Could not map Chrome frameId ${chromeFrameId} (${target.url}) to a CDP frame. Try world:"isolated" instead.`,
  );
}

function respond(id: string, ok: boolean, result?: unknown, error?: BridgeError): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const msg: ResponseMessage = ok
    ? { type: "response", id, ok: true, result }
    : { type: "response", id, ok: false, error };
  socket.send(JSON.stringify(msg));
}

async function handleRequest(msg: RequestMessage): Promise<void> {
  const token = await getToken();
  if (!token || msg.token !== token) {
    respond(
      msg.id,
      false,
      undefined,
      bridgeError(ErrorCodes.UNAUTHORIZED, "Handshake token mismatch."),
    );
    return;
  }

  try {
    const result = await route(msg.method, msg.params ?? {});
    respond(msg.id, true, result);
  } catch (err) {
    const e = err as BridgeError;
    const error: BridgeError =
      e && typeof e.code === "string" && typeof e.message === "string"
        ? e
        : bridgeError(
            ErrorCodes.UNKNOWN,
            err instanceof Error ? err.message : String(err),
          );
    await setLastError(`${error.code}: ${error.message}`);
    respond(msg.id, false, undefined, error);
  }
}

async function route(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "ping":
      return { ok: true, t: Date.now() };

    case "state.get":
      return currentState();

    case "tabs.connect": {
      const tabId = Number(params.tabId);
      const prev = await getConnectedTabId();
      if (prev != null && prev !== tabId) {
        await clearPinsAndLocal(prev);
        if (isDebuggerAttached(prev)) {
          await detachDebugger();
        }
      }
      const state = await connectTab(tabId);
      try {
        await ensureContentScript(tabId);
      } catch {
        // injection may fail until page settles; Connect still succeeds
      }
      const full = {
        ...state,
        debuggerAttached: isDebuggerAttached(tabId),
      };
      emitEvent("state.changed", full);
      return full;
    }

    case "tabs.disconnect": {
      const prev = await getConnectedTabId();
      if (isDebuggerAttached()) await detachDebugger();
      await clearPinsAndLocal(prev);
      const state = await disconnectTab();
      emitEvent("state.changed", state);
      return state;
    }

    case "tabs.list":
      return listTabs(!!params.includeOthers);

    case "tabs.navigate": {
      const tab = await requireConnectedTab();
      const url = String(params.url);
      if (isRestrictedUrl(url)) {
        throw bridgeError(ErrorCodes.RESTRICTED_URL, "Cannot navigate to restricted URL.");
      }
      await chrome.tabs.update(tab.id!, { url });
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushState();
      return { url: updated.url, title: updated.title };
    }

    case "tabs.goBack": {
      const tab = await requireConnectedTab();
      await chrome.tabs.goBack(tab.id!);
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushState();
      return { url: updated.url, title: updated.title };
    }

    case "tabs.goForward": {
      const tab = await requireConnectedTab();
      await chrome.tabs.goForward(tab.id!);
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushState();
      return { url: updated.url, title: updated.title };
    }

    case "tabs.wait": {
      const tab = await requireConnectedTab();
      const time = typeof params.time === "number" ? params.time : 0;
      const load = params.load as "complete" | "domcontentloaded" | undefined;
      if (time > 0) await new Promise((r) => setTimeout(r, time));
      if (load) await waitForLoad(tab.id!, load);
      return { ok: true };
    }

    case "page.snapshot": {
      const tab = await requireConnectedTab();
      return snapshotAllFrames(tab.id!, params.interestingOnly !== false);
    }

    case "page.find": {
      const tab = await requireConnectedTab();
      const query = String(params.query ?? "");
      const limit = typeof params.limit === "number" ? params.limit : 20;
      return findAllFrames(tab.id!, query, limit);
    }

    case "page.click": {
      const tab = await requireConnectedTab();
      const routed = withFrameLocalRefs(withPinTarget(params));
      return pageAction(tab.id!, "click", routed.params, routed.frameId);
    }

    case "page.hover": {
      const tab = await requireConnectedTab();
      const routed = withFrameLocalRefs(withPinTarget(params));
      return pageAction(tab.id!, "hover", routed.params, routed.frameId);
    }

    case "page.drag": {
      const tab = await requireConnectedTab();
      const routed = withFrameLocalRefs(withDragTargets(params));
      return pageAction(tab.id!, "drag", routed.params, routed.frameId);
    }

    case "page.type": {
      const tab = await requireConnectedTab();
      const routed = withFrameLocalRefs(withPinTarget(params));
      return pageAction(tab.id!, "type", routed.params, routed.frameId);
    }

    case "page.pickElement": {
      const tab = await requireConnectedTab();
      const prompt =
        typeof params.prompt === "string" ? params.prompt : undefined;
      const timeoutMs =
        typeof params.timeoutMs === "number"
          ? params.timeoutMs
          : PICK_ELEMENT_TIMEOUT_MS;
      return startPickerOnTab(tab.id!, {
        prompt,
        wait: true,
        timeoutMs,
      });
    }

    case "page.pickCancel": {
      const tabId = await getConnectedTabId();
      if (tabId != null) {
        try {
          await pageAction(tabId, "pickerCancel", {});
        } catch {
          // ignore
        }
      }
      cancelPick("PICK_CANCELLED");
      return { ok: true };
    }

    case "pins.list": {
      await requireConnectedTab();
      return { pins: listPins() };
    }

    case "pins.inspect": {
      const tab = await requireConnectedTab();
      const pinId = String(params.pin ?? params.id ?? "");
      if (!pinId) {
        throw bridgeError(ErrorCodes.INVALID_PIN, "pin is required");
      }
      const pin = getPin(pinId);
      if (!pin) {
        throw bridgeError(ErrorCodes.INVALID_PIN, `Unknown pin: ${pinId}`);
      }
      const inspected = (await pageAction(
        tab.id!,
        "pins.inspect",
        withPinTarget({ pin: pinId }),
      )) as Record<string, unknown>;
      return {
        pin,
        ...inspected,
        id: pinId,
        selector:
          (inspected.selector as string | null | undefined) ?? pin.selector,
      };
    }

    case "pins.clear": {
      const tab = await requireConnectedTab();
      const id = typeof params.id === "string" ? params.id : undefined;
      const result = clearPins(id);
      try {
        await pageAction(tab.id!, "pins.clearLocal", id ? { id } : {});
      } catch {
        // ignore
      }
      await syncPinsToTab(tab.id!);
      return result;
    }

    case "page.pressKey": {
      const tab = await requireConnectedTab();
      return pageAction(tab.id!, "pressKey", params);
    }

    case "page.screenshot": {
      const tab = await requireConnectedTab();
      const fullPage = !!params.fullPage;
      if (fullPage) {
        try {
          await attachDebugger(tab.id!);
          const result = (await sendCommand(tab.id!, "Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            fromSurface: true,
          })) as { data: string };
          return { mimeType: "image/png", base64: result.data };
        } catch {
          // fall through to visible
        }
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return { mimeType: "image/png", base64 };
    }

    case "page.evaluate": {
      const tab = await requireConnectedTab();
      const expression = String(params.expression);
      const world = (params.world as string) || "isolated";
      const awaitPromise = params.awaitPromise !== false;
      const pinParams = withPinTarget(params);
      const hasPinTarget = typeof pinParams.pin === "string";
      let chromeFrameId = 0;
      if (params.frame !== undefined && params.frame !== null) {
        const raw = params.frame;
        chromeFrameId = await resolveFrameSelector(
          tab.id!,
          typeof raw === "number" ? raw : String(raw),
        );
      }

      const evaluateMainCdp = async () => {
        await attachDebugger(tab.id!);
        let cdpExpression = expression;
        if (hasPinTarget) {
          const selector = pinParams.selector;
          if (typeof selector !== "string" || !selector) {
            throw bridgeError(
              ErrorCodes.INVALID_PIN,
              `Pin ${String(pinParams.pin)} has no reusable selector; re-pick the element.`,
            );
          }
          // Bind pinned element as `el` in the evaluated expression.
          cdpExpression = `((el) => {
            if (!el) throw new Error(${JSON.stringify(
              `Pinned element not found for selector: ${selector}`,
            )});
            return (${expression});
          })(document.querySelector(${JSON.stringify(selector)}))`;
        }

        const evalParams: Record<string, unknown> = {
          expression: cdpExpression,
          awaitPromise,
          returnByValue: true,
        };

        if (chromeFrameId !== 0) {
          const cdpFrameId = await cdpFrameIdForChromeFrame(
            tab.id!,
            chromeFrameId,
          );
          const worldResult = (await sendCommand(
            tab.id!,
            "Page.createIsolatedWorld",
            {
              frameId: cdpFrameId,
              worldName: "dev-tool-mcp-eval",
              grantUniveralAccess: true,
            },
          )) as { executionContextId: number };
          evalParams.contextId = worldResult.executionContextId;
        }

        const result = (await sendCommand(
          tab.id!,
          "Runtime.evaluate",
          evalParams,
        )) as {
          result?: { value?: unknown; description?: string; type?: string };
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string };
          };
        };
        if (result.exceptionDetails) {
          const detail =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Evaluation failed";
          throw bridgeError(
            ErrorCodes.CONTENT_SCRIPT_FAILED,
            formatEvaluateError(detail, "main"),
          );
        }
        return {
          result: result.result?.value ?? result.result?.description,
          world: "main" as const,
          frameId: chromeFrameId,
        };
      };

      if (world === "main") {
        return evaluateMainCdp();
      }

      try {
        const isolated = (await pageAction(
          tab.id!,
          "evaluate",
          {
            expression,
            ...pinParams,
          },
          chromeFrameId,
        )) as { result?: unknown };
        return {
          result: isolated.result,
          world: "isolated" as const,
          frameId: chromeFrameId,
        };
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message?: string }).message)
            : String(err);
        if (isUnsafeEvalCspError(message)) {
          try {
            const fallback = await evaluateMainCdp();
            return {
              ...fallback,
              fallbackFrom: "isolated",
              note: "Isolated-world evaluate hit page CSP (unsafe-eval); retried via CDP Runtime.evaluate in the main world.",
            };
          } catch (fallbackErr) {
            throw bridgeError(
              ErrorCodes.CONTENT_SCRIPT_FAILED,
              formatEvaluateError(
                fallbackErr &&
                  typeof fallbackErr === "object" &&
                  "message" in fallbackErr
                  ? String((fallbackErr as { message?: string }).message)
                  : String(fallbackErr),
                "main",
              ),
            );
          }
        }
        throw bridgeError(
          ErrorCodes.CONTENT_SCRIPT_FAILED,
          formatEvaluateError(message, "isolated"),
        );
      }
    }

    case "debugger.attach": {
      const tab = await requireConnectedTab();
      const r = await attachDebugger(tab.id!);
      await pushState();
      return r;
    }

    case "debugger.detach": {
      const r = await detachDebugger();
      await pushState();
      return r;
    }

    case "debugger.targets": {
      await requireConnectedTab();
      if (!isDebuggerAttached()) {
        const tab = await requireConnectedTab();
        await attachDebugger(tab.id!);
      }
      return listDebuggerTargets();
    }

    case "debugger.sendCommand": {
      const tab = await requireConnectedTab();
      const methodName = String(params.method);
      const cdpParams = (params.params as Record<string, unknown>) ?? {};
      return sendCommand(tab.id!, methodName, cdpParams);
    }

    case "console.list":
      return listConsole(!!params.clear);

    case "console.clear":
      return clearConsole();

    case "network.list": {
      await requireConnectedTab();
      const filter = networkFilterFromParams(params);
      if (filter.waitForMs != null && filter.waitForMs > 0) {
        const { waitForMs, ...rest } = filter;
        return waitForNetwork(rest, waitForMs);
      }
      return listNetwork(filter);
    }

    case "network.summary": {
      await requireConnectedTab();
      return listNetworkSummary({
        since:
          typeof params.since === "number" ? params.since : undefined,
        limitHosts:
          typeof params.limitHosts === "number"
            ? params.limitHosts
            : undefined,
        limitPaths:
          typeof params.limitPaths === "number"
            ? params.limitPaths
            : undefined,
      });
    }

    case "network.get": {
      await requireConnectedTab();
      return getNetworkEntry(String(params.requestId ?? params.id ?? ""));
    }

    case "network.getResponseBody": {
      const tab = await requireConnectedTab();
      return getResponseBody(tab.id!, String(params.requestId));
    }

    case "network.forPin": {
      const tab = await requireConnectedTab();
      await attachDebugger(tab.id!);
      const pinId = String(params.pin ?? "");
      if (!pinId) {
        throw bridgeError(ErrorCodes.INVALID_PIN, "pin is required");
      }
      const pin = getPin(pinId);
      if (!pin) {
        throw bridgeError(ErrorCodes.INVALID_PIN, `Unknown pin: ${pinId}`);
      }
      const inspected = (await pageAction(
        tab.id!,
        "pins.inspect",
        withPinTarget({ pin: pinId }),
      )) as { relatedUrls?: string[]; src?: string | null; currentSrc?: string | null; href?: string | null };
      const relatedUrls = [
        ...new Set(
          [
            ...(inspected.relatedUrls ?? []),
            inspected.src,
            inspected.currentSrc,
            inspected.href,
          ].filter((u): u is string => typeof u === "string" && !!u),
        ),
      ];
      const listed = listNetwork({
        limit: typeof params.limit === "number" ? params.limit : 100,
        includeWebSocketMessages: !!params.includeWebSocketMessages,
      });
      const requests = listed.requests.filter((r) =>
        relatedUrls.some(
          (u) =>
            r.url === u ||
            r.url.startsWith(u) ||
            u.startsWith(r.url.split("?")[0] ?? ""),
        ),
      );
      return {
        pin,
        relatedUrls,
        requests,
        bufferStartedAt: listed.bufferStartedAt,
        debuggerAttached: listed.debuggerAttached,
        note:
          relatedUrls.length === 0
            ? "Pin has no related URLs (inline SVG/icon or text-only node). No network correlation possible from element attributes."
            : requests.length === 0
              ? `No buffered requests matched related URLs. Capture starts at attach (bufferStartedAt=${listed.bufferStartedAt}). Re-trigger the load or pass waitForMs on network.list.`
              : undefined,
      };
    }

    case "storage.getCookies": {
      const tab = await requireConnectedTab();
      const url = tab.url!;
      const cookies = await chrome.cookies.getAll({ url });
      return { cookies };
    }

    case "storage.setCookie": {
      const tab = await requireConnectedTab();
      const cookie = params.cookie as chrome.cookies.SetDetails;
      await chrome.cookies.set({
        url: cookie.url || tab.url!,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
      });
      return { ok: true };
    }

    case "storage.clearCookies": {
      const tab = await requireConnectedTab();
      const cookies = await chrome.cookies.getAll({ url: tab.url! });
      for (const c of cookies) {
        const protocol = c.secure ? "https:" : "http:";
        const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
        await chrome.cookies.remove({
          url: `${protocol}//${host}${c.path}`,
          name: c.name,
        });
      }
      return { ok: true };
    }

    case "storage.getLocal":
    case "storage.getSession":
    case "storage.setLocal":
    case "storage.setSession":
    case "storage.clearLocal":
    case "storage.clearSession": {
      const tab = await requireConnectedTab();
      const store = method.includes("Local") ? "localStorage" : "sessionStorage";
      const action = method.includes("get")
        ? "get"
        : method.includes("set")
          ? "set"
          : "clear";
      const key = typeof params.key === "string" ? params.key : undefined;
      const value = typeof params.value === "string" ? params.value : undefined;

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        world: "MAIN",
        func: (storeName, act, k, v) => {
          const storage = (
            storeName === "localStorage" ? localStorage : sessionStorage
          ) as Storage;
          if (act === "get") {
            if (k) return { value: storage.getItem(k) };
            const all: Record<string, string> = {};
            for (let i = 0; i < storage.length; i++) {
              const kk = storage.key(i);
              if (kk != null) all[kk] = storage.getItem(kk) ?? "";
            }
            return { values: all };
          }
          if (act === "set") {
            if (!k) throw new Error("key required");
            storage.setItem(k, v ?? "");
            return { ok: true };
          }
          storage.clear();
          return { ok: true };
        },
        args: [store, action, key ?? null, value ?? null],
      });
      return result;
    }

    case "dom.getBoxModel": {
      const tab = await requireConnectedTab();
      if (typeof params.ref === "string" || typeof params.pin === "string") {
        const routed = withFrameLocalRefs(withPinTarget(params));
        return pageAction(
          tab.id!,
          "elementBox",
          routed.params,
          routed.frameId,
        );
      }
      await attachDebugger(tab.id!);
      const selector = String(params.selector ?? "");
      const doc = (await sendCommand(tab.id!, "DOM.getDocument", {
        depth: 0,
      })) as { root: { nodeId: number } };
      const { nodeId } = (await sendCommand(tab.id!, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      if (!nodeId) {
        throw bridgeError(ErrorCodes.INVALID_REF, "Selector not found.");
      }
      return sendCommand(tab.id!, "DOM.getBoxModel", { nodeId });
    }

    case "dom.getComputedStyle": {
      const tab = await requireConnectedTab();
      await attachDebugger(tab.id!);
      let selector = typeof params.selector === "string" ? params.selector : "";
      if (typeof params.ref === "string" || typeof params.pin === "string") {
        const routed = withFrameLocalRefs(withPinTarget(params));
        const box = (await pageAction(
          tab.id!,
          "elementBox",
          routed.params,
          routed.frameId,
        )) as { x: number; y: number };
        // Resolve via CDP elementFromPoint-ish using Runtime
        const evalResult = (await sendCommand(tab.id!, "Runtime.evaluate", {
          expression: `(() => {
            const el = document.elementFromPoint(${box.x + 1}, ${box.y + 1});
            if (!el) return null;
            const cs = getComputedStyle(el);
            const props = ${JSON.stringify(params.properties ?? null)};
            if (props && props.length) {
              const out = {};
              for (const p of props) out[p] = cs.getPropertyValue(p);
              return out;
            }
            return { display: cs.display, position: cs.position, color: cs.color, backgroundColor: cs.backgroundColor };
          })()`,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        return { styles: evalResult.result?.value ?? {} };
      }
      const props = (params.properties as string[] | undefined) ?? [
        "display",
        "position",
        "color",
        "background-color",
        "width",
        "height",
      ];
      const evalResult = (await sendCommand(tab.id!, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out = {};
          for (const p of ${JSON.stringify(props)}) out[p] = cs.getPropertyValue(p);
          return out;
        })()`,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (evalResult.result?.value == null) {
        throw bridgeError(ErrorCodes.INVALID_REF, "Selector not found.");
      }
      return { styles: evalResult.result.value };
    }

    default:
      throw bridgeError(ErrorCodes.UNKNOWN, `Unknown method: ${method}`);
  }
}

async function connectWs(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const port = await getPort();
  await setBridgeStatus("reconnecting");

  try {
    let token = await getToken();
    if (!token) {
      token = await fetchHandshake(port);
    }
  } catch {
    scheduleReconnect();
    return;
  }

  intentionalClose = false;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  socket = ws;

  ws.addEventListener("open", () => {
    void (async () => {
      reconnectAttempt = 0;
      await setBridgeStatus("connected");
      await setLastError(null);
      const token = await getToken();
      ws.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          role: "extension",
          token: token ?? undefined,
        }),
      );
      await pushState();
      startPing();
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
        await chrome.storage.local.set({
          [STORAGE.token]: w.token,
          [STORAGE.port]: w.port,
        });
        await pushState();
        return;
      }
      if (m.type === "request") {
        await handleRequest(m as RequestMessage);
      }
    })();
  });

  ws.addEventListener("close", () => {
    stopPing();
    if (socket === ws) socket = null;
    void setBridgeStatus("disconnected");
    if (!intentionalClose) scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  void setBridgeStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWs();
  }, delay);
}

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "ping",
          payload: { t: Date.now() },
        }),
      );
    }
  }, 20_000);
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  handleDebuggerEvent(source, method, params as Record<string, unknown>);
});

chrome.debugger.onDetach.addListener((source) => {
  handleDebuggerDetach(source);
  void pushState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const connected = await getConnectedTabId();
    if (connected === tabId) {
      if (getAttachedTabId() === tabId) await detachDebugger();
      await clearPinsAndLocal(tabId);
      await setConnectedTabId(null);
      await updateBadge(false);
      await pushState();
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  void (async () => {
    const connected = await getConnectedTabId();
    if (connected !== tabId) return;
    if (info.url && isRestrictedUrl(info.url)) {
      if (isDebuggerAttached(tabId)) await detachDebugger();
      await clearPinsAndLocal(tabId);
      await setConnectedTabId(null);
      await updateBadge(false);
      await setLastError("Auto-disconnected: restricted URL.");
      await pushState();
      return;
    }
    if (info.status === "complete" || info.title || info.url) {
      await pushState();
    }
  })();
});

chrome.webNavigation.onCommitted.addListener((details) => {
  void (async () => {
    if (details.frameId !== 0) return;
    const connected = await getConnectedTabId();
    if (connected !== details.tabId) return;
    await clearPinsAndLocal(details.tabId);
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "sw") return false;
  void (async () => {
    try {
      if (msg.type === "picker.picked") {
        const payload = msg.pin as PickPayload;
        const keepSelecting = !!msg.keepSelecting;
        const pin = completePick(payload);
        const tabId = await getConnectedTabId();
        let nextPinId: string | undefined;
        if (keepSelecting && pin && tabId != null) {
          nextPinId = armNextKeepPick(tabId);
        }
        if (tabId != null) await syncPinsToTab(tabId);
        sendResponse({ ok: true, nextPinId, pin });
        return;
      }
      if (msg.type === "picker.cancelled") {
        cancelPick("PICK_CANCELLED");
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "pins.remove") {
        const id = typeof msg.id === "string" ? msg.id : undefined;
        if (!id) {
          sendResponse({ ok: false, error: "id required" });
          return;
        }
        const tabId = await getConnectedTabId();
        clearPins(id);
        if (tabId != null) {
          try {
            await pageAction(tabId, "pins.clearLocal", { id });
          } catch {
            // ignore
          }
          await syncPinsToTab(tabId);
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "getPopupState") {
        const port = await getPort();
        const storage = await chrome.storage.local.get([
          STORAGE.bridgeStatus,
          STORAGE.lastError,
          STORAGE.port,
        ]);
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        sendResponse({
          ok: true,
          bridgeStatus: storage[STORAGE.bridgeStatus] ?? "disconnected",
          lastError: storage[STORAGE.lastError] ?? null,
          port: storage[STORAGE.port] ?? port,
          state: await currentState(),
          pinCount: pinCount(),
          activeTab: active
            ? {
                id: active.id,
                title: active.title,
                url: active.url,
                restricted: isRestrictedUrl(active.url),
              }
            : null,
        });
        return;
      }
      if (msg.type === "connectActive") {
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!active?.id) throw bridgeError(ErrorCodes.TAB_GONE, "No active tab.");
        const prev = await getConnectedTabId();
        if (prev != null && prev !== active.id) {
          await clearPinsAndLocal(prev);
          if (isDebuggerAttached(prev)) await detachDebugger();
        } else if (prev != null && isDebuggerAttached(prev)) {
          await detachDebugger();
        }
        const state = await connectTab(active.id);
        try {
          await ensureContentScript(active.id);
        } catch {
          // ok
        }
        await pushState();
        sendResponse({ ok: true, state: await currentState() });
        void state;
        return;
      }
      if (msg.type === "disconnect") {
        const prev = await getConnectedTabId();
        if (isDebuggerAttached()) await detachDebugger();
        await clearPinsAndLocal(prev);
        await disconnectTab();
        await pushState();
        sendResponse({ ok: true, state: await currentState() });
        return;
      }
      if (msg.type === "startPicker") {
        const tab = await requireConnectedTab();
        const prompt =
          typeof msg.prompt === "string" ? msg.prompt : undefined;
        const result = await startPickerOnTab(tab.id!, {
          prompt,
          wait: false,
        });
        sendResponse({ ok: true, result });
        return;
      }
      if (msg.type === "setPort") {
        await chrome.storage.local.set({ [STORAGE.port]: Number(msg.port) });
        intentionalClose = true;
        socket?.close();
        intentionalClose = false;
        reconnectAttempt = 0;
        void connectWs();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "reconnect") {
        intentionalClose = true;
        socket?.close();
        intentionalClose = false;
        reconnectAttempt = 0;
        void connectWs();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "unknown" });
    } catch (err) {
      const e = err as BridgeError;
      await setLastError(e.message ?? String(err));
      sendResponse({
        ok: false,
        error: e.message ?? String(err),
        code: e.code,
      });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void connectWs();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  void connectWs();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  void connectWs();
});

void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
void connectWs();
void (async () => {
  const id = await getConnectedTabId();
  await updateBadge(id != null);
})();
