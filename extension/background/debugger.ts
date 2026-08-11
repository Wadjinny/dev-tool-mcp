import {
  ErrorCodes,
  bridgeError,
  isCdpMethodAllowed,
  type ConsoleMessage,
  type NetworkEntry,
} from "@dev-tool-mcp/shared";

const DEBUGGER_VERSION = "1.3";
const RING = 1000;

let attachedTabId: number | null = null;
const consoleBuf: ConsoleMessage[] = [];
const networkMap = new Map<string, NetworkEntry>();
const networkOrder: string[] = [];

type EventEmitter = (event: string, payload: unknown) => void;
let emitEvent: EventEmitter = () => {};

export function setDebuggerEventEmitter(fn: EventEmitter): void {
  emitEvent = fn;
}

export function isDebuggerAttached(tabId?: number): boolean {
  if (attachedTabId == null) return false;
  if (tabId != null) return attachedTabId === tabId;
  return true;
}

export function getAttachedTabId(): number | null {
  return attachedTabId;
}

export async function attachDebugger(tabId: number): Promise<{ attached: boolean }> {
  if (attachedTabId === tabId) {
    return { attached: true };
  }
  if (attachedTabId != null && attachedTabId !== tabId) {
    await detachDebugger();
  }

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw bridgeError(
      ErrorCodes.DEBUGGER_ATTACH_FAILED,
      `Failed to attach debugger. Close DevTools on that tab and retry. (${message})`,
    );
  }

  attachedTabId = tabId;
  try {
    await sendCdp(tabId, "Runtime.enable", {});
    await sendCdp(tabId, "Console.enable", {});
    await sendCdp(tabId, "Network.enable", {});
    await sendCdp(tabId, "Page.enable", {});
  } catch {
    // domains may partially fail; keep attach
  }
  return { attached: true };
}

export async function detachDebugger(): Promise<{ attached: boolean }> {
  const tabId = attachedTabId;
  attachedTabId = null;
  if (tabId != null) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
  }
  return { attached: false };
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

export function listConsole(clear?: boolean): { messages: ConsoleMessage[] } {
  const messages = [...consoleBuf];
  if (clear) consoleBuf.length = 0;
  return { messages };
}

export function clearConsole(): { ok: true } {
  consoleBuf.length = 0;
  return { ok: true };
}

export function listNetwork(filter?: string, limit?: number): {
  requests: NetworkEntry[];
} {
  let requests = networkOrder
    .map((id) => networkMap.get(id))
    .filter((x): x is NetworkEntry => !!x);
  if (filter) {
    const f = filter.toLowerCase();
    requests = requests.filter((r) => r.url.toLowerCase().includes(f));
  }
  if (limit != null) {
    requests = requests.slice(-limit);
  }
  return { requests };
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

export function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): void {
  if (source.tabId == null || source.tabId !== attachedTabId) return;
  const p = params ?? {};

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
    pushRing(consoleBuf, entry);
    emitEvent("console.message", entry);
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
    pushRing(consoleBuf, entry);
    emitEvent("console.message", entry);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const requestId = String(p.requestId ?? "");
    const request = p.request as { url?: string; method?: string };
    const entry: NetworkEntry = {
      id: requestId,
      url: request?.url ?? "",
      method: request?.method ?? "GET",
      type: String(p.type ?? ""),
      timestamp: Date.now(),
    };
    networkMap.set(requestId, entry);
    networkOrder.push(requestId);
    trimNetwork();
    emitEvent("network.request", entry);
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = String(p.requestId ?? "");
    const response = p.response as {
      status?: number;
      mimeType?: string;
      url?: string;
    };
    const prev = networkMap.get(requestId);
    const entry: NetworkEntry = {
      id: requestId,
      url: response?.url ?? prev?.url ?? "",
      method: prev?.method ?? "GET",
      status: response?.status,
      mimeType: response?.mimeType,
      type: String(p.type ?? prev?.type ?? ""),
      timestamp: prev?.timestamp ?? Date.now(),
    };
    networkMap.set(requestId, entry);
    emitEvent("network.response", entry);
  }
}

export function handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId != null && source.tabId === attachedTabId) {
    attachedTabId = null;
    emitEvent("debugger.detached", { tabId: source.tabId });
  }
}

function pushRing<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > RING) buf.splice(0, buf.length - RING);
}

function trimNetwork(): void {
  while (networkOrder.length > RING) {
    const id = networkOrder.shift();
    if (id) networkMap.delete(id);
  }
}
