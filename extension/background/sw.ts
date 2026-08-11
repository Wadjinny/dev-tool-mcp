import {
  DEFAULT_WS_PORT,
  ErrorCodes,
  PROTOCOL_VERSION,
  bridgeError,
  type BridgeError,
  type BridgeState,
  type RequestMessage,
  type ResponseMessage,
} from "@dev-tool-mcp/shared";
import {
  attachDebugger,
  clearConsole,
  detachDebugger,
  getAttachedTabId,
  getResponseBody,
  handleDebuggerDetach,
  handleDebuggerEvent,
  isDebuggerAttached,
  listConsole,
  listNetwork,
  sendCommand,
  setDebuggerEventEmitter,
} from "./debugger.js";
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

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const ping = (await chrome.tabs.sendMessage(tabId, {
      channel: "dev-tool-mcp",
      action: "ping",
      params: {},
    })) as { ok?: boolean } | undefined;
    if (ping?.ok) return;
  } catch {
    // not injected yet
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
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

async function pageAction(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  await ensureContentScript(tabId);
  let response:
    | { ok: true; result: unknown }
    | { ok: false; error: BridgeError }
    | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, {
      channel: "dev-tool-mcp",
      action,
      params,
    })) as typeof response;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/automation.js"],
    });
    response = (await chrome.tabs.sendMessage(tabId, {
      channel: "dev-tool-mcp",
      action,
      params,
    })) as typeof response;
  }

  if (!response) {
    throw bridgeError(
      ErrorCodes.CONTENT_SCRIPT_FAILED,
      "No response from content script.",
    );
  }
  if (!response.ok) {
    throw response.error;
  }
  return response.result;
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
      if (prev != null && prev !== tabId && isDebuggerAttached(prev)) {
        await detachDebugger();
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
      if (isDebuggerAttached()) await detachDebugger();
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
      return pageAction(tab.id!, "snapshot", {
        interestingOnly: params.interestingOnly !== false,
      });
    }

    case "page.click": {
      const tab = await requireConnectedTab();
      return pageAction(tab.id!, "click", params);
    }

    case "page.hover": {
      const tab = await requireConnectedTab();
      return pageAction(tab.id!, "hover", params);
    }

    case "page.drag": {
      const tab = await requireConnectedTab();
      return pageAction(tab.id!, "drag", params);
    }

    case "page.type": {
      const tab = await requireConnectedTab();
      return pageAction(tab.id!, "type", params);
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

      if (world === "main") {
        await attachDebugger(tab.id!);
        const result = (await sendCommand(tab.id!, "Runtime.evaluate", {
          expression,
          awaitPromise,
          returnByValue: true,
        })) as {
          result?: { value?: unknown; description?: string; type?: string };
          exceptionDetails?: { text?: string };
        };
        if (result.exceptionDetails) {
          throw bridgeError(
            ErrorCodes.CONTENT_SCRIPT_FAILED,
            result.exceptionDetails.text ?? "Evaluation failed",
          );
        }
        return { result: result.result?.value ?? result.result?.description };
      }

      return pageAction(tab.id!, "evaluate", { expression });
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

    case "network.list":
      return listNetwork(
        typeof params.filter === "string" ? params.filter : undefined,
        typeof params.limit === "number" ? params.limit : undefined,
      );

    case "network.getResponseBody": {
      const tab = await requireConnectedTab();
      return getResponseBody(tab.id!, String(params.requestId));
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
      if (typeof params.ref === "string") {
        return pageAction(tab.id!, "elementBox", { ref: params.ref });
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
      if (typeof params.ref === "string") {
        const box = (await pageAction(tab.id!, "elementBox", {
          ref: params.ref,
        })) as { x: number; y: number };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "sw") return false;
  void (async () => {
    try {
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
        if (prev != null && isDebuggerAttached(prev)) await detachDebugger();
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
        if (isDebuggerAttached()) await detachDebugger();
        await disconnectTab();
        await pushState();
        sendResponse({ ok: true, state: await currentState() });
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
