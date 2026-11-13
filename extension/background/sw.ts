import {
  DEFAULT_WS_PORT,
  ERROR_MESSAGES,
  ErrorCodes,
  PICK_ELEMENT_TIMEOUT_MS,
  SECURE_INPUT_TIMEOUT_MS,
  bridgeError,
  type BridgeError,
  type BridgeState,
  type NetworkListFilter,
  type RequestMessage,
} from "@dev-tool-mcp/shared";
import {
  attachDebugger,
  clearConsole,
  detachDebugger,
  forgetTab,
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
  anyExtensionConnected,
  askUserConsent,
  connectedPorts,
  emitEventToPort,
  getControllerPort,
  getTokenForPort,
  identityOfPort,
  isPortAutoAllowed,
  initHubListeners,
  labelForPort,
  onIdentitiesChanged,
  pendingControlLabel,
  reconnectAll,
  refreshBridges,
  respond,
  setHubHooks,
  setLastError,
  setManualControl,
  startHub,
  summaryBridgeStatus,
} from "./hub.js";
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
  resetPinsForTab,
  type PickPayload,
} from "./pins.js";
import {
  assertConnectable,
  buildState,
  getTab,
  getTabOwner,
  isRestrictedUrl,
  listOwnedTabs,
  listTabs,
  onTabOwnerChanged,
  releaseTabsOfPort,
  requireTabFor,
  sameOwner,
  setTabOwner,
  tabIdForOwner,
  waitForLoad,
  watchNavigation,
  type TabOwner,
} from "./tabs.js";
import {
  markActivity,
  refreshIndicator,
  relabelAll,
  setIndicatorLabelProvider,
  setTabIndicator,
  withOverlayHidden,
} from "./indicator.js";
import {
  cancelSecureInputForTab,
  handleSecureInputMessage,
  withSecureInput,
} from "./secure-input.js";

/** RPCs that don't act on the page, so they shouldn't pulse the indicator. */
const QUIET_METHODS = new Set([
  "ping",
  "state.get",
  "tabs.list",
  "control.status",
]);

/** How long a vanished bridge keeps its tab (MCP restart, SW wake-up). */
const RELEASE_GRACE_MS = 60_000;
/** Port -> when we first saw it owning a tab without an open socket. */
const missingSince = new Map<number, number>();

/**
 * Release tabs whose session has been gone for RELEASE_GRACE_MS. Runs on the
 * 30 s keepalive alarm (timers alone die when Chrome suspends the worker) and
 * shortly after a socket closes.
 */
async function sweepOrphanTabs(): Promise<void> {
  const live = new Set(connectedPorts());
  const now = Date.now();
  const ports = new Set((await listOwnedTabs()).map(([, o]) => o.port));
  for (const port of ports) {
    if (live.has(port)) {
      missingSince.delete(port);
      continue;
    }
    const since = missingSince.get(port) ?? now;
    missingSince.set(port, since);
    if (now - since >= RELEASE_GRACE_MS) {
      missingSince.delete(port);
      await releaseTabsOfPort(port);
    }
  }
}

setIndicatorLabelProvider((port) => labelForPort(port));
onIdentitiesChanged(() => {
  void (async () => {
    // A port may now belong to a different process: drop its old tabs first.
    for (const port of connectedPorts()) await dropStaleOwnership(port);
    await relabelAll();
  })();
});

onTabOwnerChanged(async (tabId, prev, next) => {
  if (prev && !sameOwner(prev, next)) {
    // Leaving a session: drop its tab-scoped capture, pins and picker.
    cancelSecureInputForTab(tabId, "The tab was released before the secret was submitted.");
    await clearPinsAndLocal(tabId);
    await forgetTab(tabId);
  }
  await setTabIndicator(tabId, next?.port ?? null);
  if (prev) void pushStateTo(prev.port);
  if (next && next.port !== prev?.port) void pushStateTo(next.port);
});

setHubHooks({
  onRequest: (msg, ws, port) => handleRequest(msg, ws, port),
  onConnected: async (port) => {
    missingSince.delete(port);
    await dropStaleOwnership(port);
    await pushStateTo(port);
  },
  onDisconnected: (port) => {
    void (async () => {
      // Cancel prompts for this session's tabs only, not other sessions'.
      for (const [tabId, owner] of await listOwnedTabs()) {
        if (owner.port === port) {
          cancelSecureInputForTab(
            tabId,
            "The MCP session disconnected before the secret was submitted.",
          );
        }
      }
    })();
    if (!missingSince.has(port)) missingSince.set(port, Date.now());
    setTimeout(() => void sweepOrphanTabs(), RELEASE_GRACE_MS + 1_000);
  },
});

// CDP events go only to the session that owns the tab.
setDebuggerEventEmitter((event, payload, tabId) => {
  void (async () => {
    const owner = await getTabOwner(tabId);
    if (owner) emitEventToPort(owner.port, event, payload);
  })();
});
initHubListeners();

function ownerOf(port: number): TabOwner {
  return { port, startedAt: identityOfPort(port)?.startedAt ?? null };
}

/** A new MCP process reusing a port must not inherit the old process's tab. */
async function dropStaleOwnership(port: number): Promise<void> {
  const me = ownerOf(port);
  if (me.startedAt == null) return;
  for (const [tabId, o] of await listOwnedTabs()) {
    if (o.port === port && o.startedAt != null && o.startedAt !== me.startedAt) {
      await setTabOwner(tabId, null);
    }
  }
}

async function stateFor(port: number): Promise<BridgeState> {
  const tabId = await tabIdForOwner(ownerOf(port));
  const base = await buildState(anyExtensionConnected(), tabId);
  return {
    ...base,
    debuggerAttached: tabId != null && isDebuggerAttached(tabId),
  };
}

async function pushStateTo(port: number): Promise<void> {
  emitEventToPort(port, "state.changed", await stateFor(port));
}

async function pushStateForTab(tabId: number): Promise<void> {
  const owner = await getTabOwner(tabId);
  if (owner) await pushStateTo(owner.port);
}

/** What browser_control_status returns now that each session owns a tab. */
async function sessionStatus(port: number): Promise<unknown> {
  const tabId = await tabIdForOwner(ownerOf(port));
  const tab = tabId != null ? await getTab(tabId) : null;
  const others = (await listOwnedTabs())
    .filter(([, o]) => o.port !== port)
    .map(([id, o]) => ({ tabId: id, session: labelForPort(o.port) }));
  return {
    self: identityOfPort(port),
    label: labelForPort(port),
    connectedTab: tab
      ? { id: tab.id, url: tab.url, title: tab.title, active: tab.active }
      : null,
    otherSessions: others,
    note: "Each MCP session owns its own Connected tab, so no control lease is needed. Use browser_connect_tab to take over an existing tab (the user is asked to Allow).",
  };
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
  tabId: number,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof params.pin === "string") {
    const pin = getPin(tabId, params.pin);
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
  tabId: number,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  if (typeof params.startPin === "string") {
    const pin = getPin(tabId, params.startPin);
    if (!pin) {
      throw bridgeError(
        ErrorCodes.INVALID_PIN,
        `Unknown pin: ${params.startPin}`,
      );
    }
    out.startSelector = pin.selector;
  }
  if (typeof params.endPin === "string") {
    const pin = getPin(tabId, params.endPin);
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
      pins: listPins(tabId),
    });
  } catch {
    // content may be gone
  }
}

async function clearPinsAndLocal(tabId: number): Promise<void> {
  resetPinsForTab(tabId);
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
  const pinId = allocatePinId(tabId);
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
    cancelPick(tabId, "PICK_CANCELLED");
    throw err;
  }
  if (!opts.wait) {
    setTimeout(() => {
      void (async () => {
        if (!isActivePick(tabId, pinId)) return;
        try {
          await pageAction(tabId, "pickerCancel", {});
        } catch {
          // ignore
        }
        if (isActivePick(tabId, pinId)) cancelPick(tabId, "PICK_CANCELLED");
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

async function handleRequest(
  msg: RequestMessage,
  ws: WebSocket,
  port: number,
): Promise<void> {
  const token = await getTokenForPort(port);
  if (!token || msg.token !== token) {
    respond(
      ws,
      msg.id,
      false,
      undefined,
      bridgeError(ErrorCodes.UNAUTHORIZED, "Handshake token mismatch."),
    );
    return;
  }

  try {
    if (msg.method === "control.request" || msg.method === "control.status") {
      respond(ws, msg.id, true, await sessionStatus(port));
      return;
    }
    if (msg.method === "control.release") {
      const own = await tabIdForOwner(ownerOf(port));
      if (own != null) await setTabOwner(own, null);
      respond(ws, msg.id, true, await sessionStatus(port));
      return;
    }

    const quiet = QUIET_METHODS.has(msg.method);
    const pulse = async () => {
      if (quiet) return;
      const own = await tabIdForOwner(ownerOf(port));
      if (own != null) markActivity(own);
    };
    await pulse();
    try {
      const result = await route(msg.method, msg.params ?? {}, port);
      respond(ws, msg.id, true, result);
    } finally {
      await pulse();
    }
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
    respond(ws, msg.id, false, undefined, error);
  }
}

/** Give a tab to a session (user already consented or the agent created it). */
async function assignTab(port: number, tabId: number): Promise<void> {
  await setTabOwner(tabId, ownerOf(port));
  try {
    await ensureContentScript(tabId);
  } catch {
    // injection may fail until page settles; Connect still succeeds
  }
}

/** browser_connect_tab: take over an existing tab, always with the user's Allow. */
async function connectExistingTab(
  port: number,
  tabId: number,
): Promise<unknown> {
  const tab = await assertConnectable(tabId);
  const me = ownerOf(port);
  const current = await getTabOwner(tabId);
  if (!sameOwner(current, me) && isPortAutoAllowed(port)) {
    // Trusted auto-allow instance: take the tab over without prompting.
    await assignTab(port, tabId);
  } else if (!sameOwner(current, me)) {
    let origin = tab.url ?? "";
    try {
      origin = new URL(tab.url ?? "").host;
    } catch {
      // keep raw
    }
    const answer = await askUserConsent(
      "dev-tool-mcp: connect a tab",
      `${labelForPort(port)} wants to control "${tab.title ?? "tab"}" (${origin}).` +
        (current ? `\nCurrently controlled by ${labelForPort(current.port)}.` : ""),
    );
    if (answer === "timeout") {
      throw bridgeError(
        ErrorCodes.CONTROL_REQUEST_TIMEOUT,
        "No answer to the Allow/Deny notification within 60s (the user may not have seen it). Ask the user, then call browser_connect_tab again.",
      );
    }
    if (answer === "denied") {
      throw bridgeError(
        ErrorCodes.CONTROL_DENIED,
        "The user denied this session control of that tab.",
      );
    }
    await assignTab(port, tabId);
  }
  const updated = await getTab(tabId);
  return {
    tabId,
    url: updated?.url,
    title: updated?.title,
    connected: true,
  };
}

/**
 * Open a URL in a new tab owned by this session. With recordNetwork the
 * debugger is attached *before* navigating, so the page's own load is captured.
 */
async function openAndConnectTab(
  port: number,
  url: string,
  active: boolean,
  recordNetwork: boolean,
): Promise<{
  url: string | undefined;
  title: string | undefined;
  tabId: number;
  opened: boolean;
  connectedTabId: number | null;
  recordingNetwork: boolean;
}> {
  if (isRestrictedUrl(url)) {
    throw bridgeError(
      ErrorCodes.RESTRICTED_URL,
      "Cannot open a restricted URL.",
    );
  }
  const created = await chrome.tabs.create({
    url: recordNetwork ? "about:blank" : url,
    active,
  });
  if (created.id == null) {
    throw bridgeError(ErrorCodes.TAB_GONE, "Failed to create tab.");
  }
  const tabId = created.id;
  if (recordNetwork) {
    await setTabOwner(tabId, ownerOf(port));
    await attachDebugger(tabId);
    await chrome.tabs.update(tabId, { url });
  }
  await waitForLoad(tabId, "complete");
  const updated = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(updated.url)) {
    await setTabOwner(tabId, null);
    await chrome.tabs.remove(tabId).catch(() => undefined);
    throw bridgeError(
      ErrorCodes.RESTRICTED_URL,
      "Opened tab landed on a restricted URL.",
    );
  }
  await assignTab(port, tabId);
  return {
    url: updated.url,
    title: updated.title,
    tabId,
    opened: true,
    connectedTabId: tabId,
    recordingNetwork: isDebuggerAttached(tabId),
  };
}

/**
 * Run a page action that may trigger a navigation (click, Enter, submit) and,
 * unless disabled, wait for that navigation to finish before returning.
 */
async function withNavigationWait(
  tabId: number,
  enabled: boolean,
  action: () => Promise<unknown>,
): Promise<unknown> {
  if (!enabled) return action();
  const nav = watchNavigation(tabId);
  let result: unknown;
  try {
    result = await action();
  } catch (err) {
    nav.dispose();
    throw err;
  }
  const settled = await nav.settle({ graceMs: 400, timeoutMs: 30_000 });
  if (!settled.navigated) return result;
  const tab = await getTab(tabId);
  const base =
    result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return {
    ...base,
    navigated: true,
    url: tab?.url,
    title: tab?.title,
    ...(settled.sameDocument ? { sameDocument: true } : {}),
    ...(settled.timedOut
      ? { note: "Navigation started but did not finish within 30s." }
      : {}),
  };
}

async function route(
  method: string,
  params: Record<string, unknown>,
  port: number,
): Promise<unknown> {
  const me = ownerOf(port);
  switch (method) {
    case "ping":
      return { ok: true, t: Date.now() };

    case "state.get":
      return stateFor(port);

    case "tabs.connect":
      return connectExistingTab(port, Number(params.tabId));

    case "tabs.disconnect": {
      const own = await tabIdForOwner(me);
      if (own != null) await setTabOwner(own, null);
      return stateFor(port);
    }

    case "tabs.list":
      return listTabs(me, !!params.includeOthers, labelForPort);

    case "tabs.open": {
      const url = String(params.url);
      return openAndConnectTab(
        port,
        url,
        params.active !== false,
        params.recordNetwork === true,
      );
    }

    case "tabs.navigate": {
      const url = String(params.url);
      const recordNetwork = params.recordNetwork === true;
      const existingId = await tabIdForOwner(me);
      if (existingId == null) {
        return openAndConnectTab(port, url, true, recordNetwork);
      }
      const tab = await requireTabFor(me);
      if (isRestrictedUrl(url)) {
        throw bridgeError(ErrorCodes.RESTRICTED_URL, "Cannot navigate to restricted URL.");
      }
      if (recordNetwork) await attachDebugger(tab.id!);
      await chrome.tabs.update(tab.id!, { url });
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushStateTo(port);
      return {
        url: updated.url,
        title: updated.title,
        tabId: updated.id,
        opened: false,
        recordingNetwork: isDebuggerAttached(tab.id!),
      };
    }

    case "tabs.goBack": {
      const tab = await requireTabFor(me);
      await chrome.tabs.goBack(tab.id!);
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushStateTo(port);
      return { url: updated.url, title: updated.title };
    }

    case "tabs.goForward": {
      const tab = await requireTabFor(me);
      await chrome.tabs.goForward(tab.id!);
      await waitForLoad(tab.id!, "complete");
      const updated = await chrome.tabs.get(tab.id!);
      await pushStateTo(port);
      return { url: updated.url, title: updated.title };
    }

    case "tabs.wait": {
      const tab = await requireTabFor(me);
      const time = typeof params.time === "number" ? params.time : 0;
      const load = params.load as "complete" | "domcontentloaded" | undefined;
      if (time > 0) await new Promise((r) => setTimeout(r, time));
      if (load) await waitForLoad(tab.id!, load);
      return { ok: true };
    }

    case "page.snapshot": {
      const tab = await requireTabFor(me);
      return snapshotAllFrames(tab.id!, params.interestingOnly !== false);
    }

    case "page.find": {
      const tab = await requireTabFor(me);
      const query = String(params.query ?? "");
      const limit = typeof params.limit === "number" ? params.limit : 20;
      return findAllFrames(tab.id!, query, limit);
    }

    case "page.click": {
      const tab = await requireTabFor(me);
      const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
      return withNavigationWait(tab.id!, params.waitForNavigation !== false, () =>
        pageAction(tab.id!, "click", routed.params, routed.frameId),
      );
    }

    case "page.hover": {
      const tab = await requireTabFor(me);
      const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
      return pageAction(tab.id!, "hover", routed.params, routed.frameId);
    }

    case "page.drag": {
      const tab = await requireTabFor(me);
      const routed = withFrameLocalRefs(withDragTargets(tab.id!, params));
      return pageAction(tab.id!, "drag", routed.params, routed.frameId);
    }

    case "page.type": {
      const tab = await requireTabFor(me);
      const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
      return withNavigationWait(
        tab.id!,
        params.submit === true && params.waitForNavigation !== false,
        () => pageAction(tab.id!, "type", routed.params, routed.frameId),
      );
    }

    case "page.typeSecure": {
      const tab = await requireTabFor(me);
      // Resolve the target before prompting: a stale ref should fail fast,
      // not after the user has typed their secret.
      const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
      const submit = params.submit === true;
      const waitForNavigation = submit && params.waitForNavigation !== false;
      const timeoutMs =
        typeof params.timeoutMs === "number"
          ? Math.max(5_000, Math.min(params.timeoutMs, 300_000))
          : SECURE_INPUT_TIMEOUT_MS;
      let site = "";
      try {
        site = new URL(tab.url ?? "").host;
      } catch {
        // keep empty
      }
      const rawLabel =
        typeof params.label === "string" ? params.label.trim() : "";
      const label = (rawLabel || (site ? `Secure input for ${site}` : "Secure input"))
        .slice(0, 120);
      const kind =
        params.kind === "text" || params.kind === "otp"
          ? params.kind
          : "password";
      const targetHint =
        typeof params.targetHint === "string"
          ? params.targetHint.trim().slice(0, 120)
          : "";

      return withSecureInput(
        {
          tabId: tab.id!,
          label,
          site: site || "the Connected tab",
          target: targetHint || undefined,
          kind,
          submit,
          timeoutMs,
        },
        async (secret) => {
          const typed = await withNavigationWait(tab.id!, waitForNavigation, () =>
            pageAction(
              tab.id!,
              "typeSecret",
              { ...routed.params, text: secret, submit },
              routed.frameId,
            ),
          );
          return {
            ok: true,
            filled: true,
            chars: secret.length,
            submitted: submit,
            ...(typed && typeof typed === "object" ? typed : {}),
          };
        },
      );
    }

    case "page.pickElement": {
      const tab = await requireTabFor(me);
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
      const tabId = await tabIdForOwner(me);
      if (tabId != null) {
        try {
          await pageAction(tabId, "pickerCancel", {});
        } catch {
          // ignore
        }
        cancelPick(tabId, "PICK_CANCELLED");
      }
      return { ok: true };
    }

    case "pins.list": {
      const tab = await requireTabFor(me);
      return { pins: listPins(tab.id!) };
    }

    case "pins.inspect": {
      const tab = await requireTabFor(me);
      const pinId = String(params.pin ?? params.id ?? "");
      if (!pinId) {
        throw bridgeError(ErrorCodes.INVALID_PIN, "pin is required");
      }
      const pin = getPin(tab.id!, pinId);
      if (!pin) {
        throw bridgeError(ErrorCodes.INVALID_PIN, `Unknown pin: ${pinId}`);
      }
      const inspected = (await pageAction(
        tab.id!,
        "pins.inspect",
        withPinTarget(tab.id!, { pin: pinId }),
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
      const tab = await requireTabFor(me);
      const id = typeof params.id === "string" ? params.id : undefined;
      const result = clearPins(tab.id!, id);
      try {
        await pageAction(tab.id!, "pins.clearLocal", id ? { id } : {});
      } catch {
        // ignore
      }
      await syncPinsToTab(tab.id!);
      return result;
    }

    case "page.pressKey": {
      const tab = await requireTabFor(me);
      return withNavigationWait(tab.id!, params.waitForNavigation !== false, () =>
        pageAction(tab.id!, "pressKey", params),
      );
    }

    case "page.screenshot": {
      const tab = await requireTabFor(me);
      const tabId = tab.id!;
      const fullPage = !!params.fullPage;
      return withOverlayHidden(tabId, async () => {
        // captureVisibleTab grabs whatever tab is in front of the window, so it
        // must only be used when that is the Connected tab. Otherwise use CDP.
        const [front] = await chrome.tabs.query({
          active: true,
          windowId: tab.windowId,
        });
        const isFront = front?.id === tabId;
        if (!isFront) {
          // CDP capture of a background tab hangs until timeout; fail fast.
          throw bridgeError(
            ErrorCodes.TAB_NOT_VISIBLE,
            ERROR_MESSAGES.TAB_NOT_VISIBLE,
          );
        }
        if (fullPage) {
          try {
            await attachDebugger(tabId);
            const result = (await withTimeout(
              sendCommand(tabId, "Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: true,
                fromSurface: true,
              }),
              8_000,
            )) as { data: string };
            return { mimeType: "image/png", base64: result.data };
          } catch {
            // fall through to visible capture
          }
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
        });
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        return { mimeType: "image/png", base64 };
      });
    }

    case "page.evaluate": {
      const tab = await requireTabFor(me);
      const expression = String(params.expression);
      const world = (params.world as string) || "isolated";
      const awaitPromise = params.awaitPromise !== false;
      const pinParams = withPinTarget(tab.id!, params);
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
      const tab = await requireTabFor(me);
      const r = await attachDebugger(tab.id!);
      await pushStateTo(port);
      return r;
    }

    case "debugger.detach": {
      const tabId = await tabIdForOwner(me);
      const r =
        tabId != null ? await detachDebugger(tabId) : { attached: false };
      await pushStateTo(port);
      return r;
    }

    case "debugger.targets": {
      const tab = await requireTabFor(me);
      if (!isDebuggerAttached(tab.id!)) await attachDebugger(tab.id!);
      return listDebuggerTargets(tab.id!);
    }

    case "debugger.sendCommand": {
      const tab = await requireTabFor(me);
      const methodName = String(params.method);
      const cdpParams = (params.params as Record<string, unknown>) ?? {};
      return sendCommand(tab.id!, methodName, cdpParams);
    }

    case "console.list": {
      const tab = await requireTabFor(me);
      return listConsole(tab.id!, !!params.clear);
    }

    case "console.clear": {
      const tab = await requireTabFor(me);
      return clearConsole(tab.id!);
    }

    case "network.list": {
      const tab = await requireTabFor(me);
      const filter = networkFilterFromParams(params);
      if (filter.waitForMs != null && filter.waitForMs > 0) {
        const { waitForMs, ...rest } = filter;
        return waitForNetwork(tab.id!, rest, waitForMs);
      }
      return listNetwork(tab.id!, filter);
    }

    case "network.summary": {
      const tab = await requireTabFor(me);
      return listNetworkSummary(tab.id!, {
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
      const tab = await requireTabFor(me);
      return getNetworkEntry(
        tab.id!,
        String(params.requestId ?? params.id ?? ""),
      );
    }

    case "network.getResponseBody": {
      const tab = await requireTabFor(me);
      return getResponseBody(tab.id!, String(params.requestId));
    }

    case "network.forPin": {
      const tab = await requireTabFor(me);
      await attachDebugger(tab.id!);
      const pinId = String(params.pin ?? "");
      if (!pinId) {
        throw bridgeError(ErrorCodes.INVALID_PIN, "pin is required");
      }
      const pin = getPin(tab.id!, pinId);
      if (!pin) {
        throw bridgeError(ErrorCodes.INVALID_PIN, `Unknown pin: ${pinId}`);
      }
      const inspected = (await pageAction(
        tab.id!,
        "pins.inspect",
        withPinTarget(tab.id!, { pin: pinId }),
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
      const listed = listNetwork(tab.id!, {
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
      const tab = await requireTabFor(me);
      const url = tab.url!;
      const cookies = await chrome.cookies.getAll({ url });
      return { cookies };
    }

    case "storage.setCookie": {
      const tab = await requireTabFor(me);
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
      const tab = await requireTabFor(me);
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
      const tab = await requireTabFor(me);
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
      const tab = await requireTabFor(me);
      if (typeof params.ref === "string" || typeof params.pin === "string") {
        const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
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
      const tab = await requireTabFor(me);
      await attachDebugger(tab.id!);
      let selector = typeof params.selector === "string" ? params.selector : "";
      if (typeof params.ref === "string" || typeof params.pin === "string") {
        const routed = withFrameLocalRefs(withPinTarget(tab.id!, params));
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

chrome.debugger.onEvent.addListener((source, method, params) => {
  handleDebuggerEvent(source, method, params as Record<string, unknown>);
});

chrome.debugger.onDetach.addListener((source) => {
  handleDebuggerDetach(source);
  if (source.tabId != null) void pushStateForTab(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelSecureInputForTab(tabId, "The tab was closed before the secret was submitted.");
  void (async () => {
    if (await getTabOwner(tabId)) await setTabOwner(tabId, null);
    await forgetTab(tabId);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  void (async () => {
    if (!(await getTabOwner(tabId))) return;
    // about:blank is the transient start page of browser_open(recordNetwork).
    if (info.url && info.url !== "about:blank" && isRestrictedUrl(info.url)) {
      await setTabOwner(tabId, null);
      await setLastError("Auto-disconnected: restricted URL.");
      return;
    }
    if (info.status === "complete" || info.title || info.url) {
      await pushStateForTab(tabId);
    }
  })();
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId !== 0) return;
  void refreshIndicator(details.tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  void (async () => {
    if (details.frameId !== 0) return;
    if (!(await getTabOwner(details.tabId))) return;
    cancelSecureInputForTab(
      details.tabId,
      "The page navigated before the secret was submitted.",
    );
    await clearPinsAndLocal(details.tabId);
  })();
});

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return active;
}

/** Session the popup's Connect button assigns tabs to. */
async function popupTargetPort(): Promise<number> {
  const live = connectedPorts();
  const preferred = await getControllerPort();
  if (preferred != null && live.includes(preferred)) return preferred;
  if (live.length === 1) return live[0]!;
  if (live.length === 0) {
    throw bridgeError(
      ErrorCodes.EXTENSION_DISCONNECTED,
      "No MCP session is connected to the extension.",
    );
  }
  throw bridgeError(
    ErrorCodes.UNKNOWN,
    "Several MCP sessions are connected. Click a session card to choose a Connect target first.",
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "sw") return false;
  void (async () => {
    try {
      // Messages from content scripts (picker, pin panel, overlay Stop) carry
      // their tab; popup messages act on the active tab.
      const senderTabId = sender.tab?.id;

      if (msg.type === "secure.submit" || msg.type === "secure.cancel") {
        const result = await handleSecureInputMessage(msg);
        if (result.handled) {
          sendResponse(
            result.ok ? { ok: true } : { ok: false, error: result.error },
          );
          return;
        }
      }

      if (msg.type === "picker.picked") {
        if (senderTabId == null) throw new Error("picker message without tab");
        const payload = msg.pin as PickPayload;
        const keepSelecting = !!msg.keepSelecting;
        const pin = completePick(senderTabId, payload);
        let nextPinId: string | undefined;
        if (keepSelecting && pin) nextPinId = armNextKeepPick(senderTabId);
        await syncPinsToTab(senderTabId);
        sendResponse({ ok: true, nextPinId, pin });
        return;
      }
      if (msg.type === "picker.cancelled") {
        if (senderTabId != null) cancelPick(senderTabId, "PICK_CANCELLED");
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "pins.remove") {
        const id = typeof msg.id === "string" ? msg.id : undefined;
        if (!id || senderTabId == null) {
          sendResponse({ ok: false, error: "id required" });
          return;
        }
        clearPins(senderTabId, id);
        try {
          await pageAction(senderTabId, "pins.clearLocal", { id });
        } catch {
          // ignore
        }
        await syncPinsToTab(senderTabId);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "getPopupState") {
        const port = (await getControllerPort()) ?? Number(DEFAULT_WS_PORT);
        const storage = await chrome.storage.local.get(["lastError", "wsPort"]);
        const active = await activeTab();
        const owner = active?.id != null ? await getTabOwner(active.id) : null;
        const state = await buildState(
          anyExtensionConnected(),
          owner ? active!.id! : null,
        );
        sendResponse({
          ok: true,
          bridgeStatus: summaryBridgeStatus(),
          lastError: storage.lastError ?? null,
          port: storage.wsPort ?? port,
          pendingLabel: pendingControlLabel(),
          state: {
            ...state,
            debuggerAttached: owner ? isDebuggerAttached(active!.id!) : false,
          },
          ownerLabel: owner ? labelForPort(owner.port) : null,
          sessionCount: (await listOwnedTabs()).length,
          pinCount: owner ? pinCount(active!.id!) : 0,
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
        const active = await activeTab();
        if (!active?.id) throw bridgeError(ErrorCodes.TAB_GONE, "No active tab.");
        await assertConnectable(active.id);
        // The user clicked Connect themselves, so no extra consent prompt.
        await assignTab(await popupTargetPort(), active.id);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "disconnect") {
        const tabId =
          typeof msg.tabId === "number"
            ? msg.tabId
            : (senderTabId ?? (await activeTab())?.id);
        if (tabId != null && (await getTabOwner(tabId))) {
          await setTabOwner(tabId, null);
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "startPicker") {
        const active = await activeTab();
        if (!active?.id || !(await getTabOwner(active.id))) {
          throw bridgeError(
            ErrorCodes.NO_CONNECTED_TAB,
            "Connect this tab first.",
          );
        }
        const prompt =
          typeof msg.prompt === "string" ? msg.prompt : undefined;
        const result = await startPickerOnTab(active.id, {
          prompt,
          wait: false,
        });
        sendResponse({ ok: true, result });
        return;
      }
      if (msg.type === "detachDebugger") {
        const active = await activeTab();
        if (!active?.id || !(await getTabOwner(active.id))) {
          throw bridgeError(
            ErrorCodes.NO_CONNECTED_TAB,
            "Connect this tab first.",
          );
        }
        await detachDebugger(active.id);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "listBridges") {
        const bridges = await refreshBridges();
        const owned = await listOwnedTabs();
        const withTabs = await Promise.all(
          bridges.map(async (b) => {
            const entry = owned.find(([, o]) => o.port === b.port);
            const tab = entry ? await getTab(entry[0]) : null;
            return {
              ...b,
              tabTitle: tab?.title ?? null,
              tabUrl: tab?.url ?? null,
            };
          }),
        );
        sendResponse({
          ok: true,
          bridges: withTabs,
          activePort: await getControllerPort(),
          pendingLabel: pendingControlLabel(),
        });
        return;
      }
      if (msg.type === "setPort" || msg.type === "controlPort") {
        const next = Number(msg.port);
        if (!Number.isInteger(next) || next < 1 || next > 65535) {
          sendResponse({ ok: false, error: "Invalid port." });
          return;
        }
        const bridges = await setManualControl(next);
        sendResponse({
          ok: true,
          bridges,
          activePort: next,
          pendingLabel: pendingControlLabel(),
        });
        return;
      }
      if (msg.type === "reconnect") {
        await reconnectAll();
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
    void startHub().then(() => sweepOrphanTabs());
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  void startHub();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  void startHub();
});

void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
void startHub();
void (async () => {
  // SW restarts lose in-memory indicator state; restore it for owned tabs.
  await chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
  for (const [tabId, owner] of await listOwnedTabs()) {
    if (await getTab(tabId)) await setTabIndicator(tabId, owner.port);
    else await setTabOwner(tabId, null);
  }
})();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
