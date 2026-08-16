import type { BridgeError } from "./errors.js";

export const DEFAULT_WS_PORT = 17373;

/**
 * Bridges must stay inside a small, fixed band so the extension can find every
 * running instance with a bounded scan. Binding outside this band (e.g. an
 * ephemeral port) makes an instance undiscoverable.
 */
export const DISCOVERY_BASE_PORT = 17373;
export const DISCOVERY_PORT_COUNT = 20;

/** Candidate ports, preferred first, then the discovery band in order. */
export function discoveryPorts(preferred?: number): number[] {
  const band = Array.from(
    { length: DISCOVERY_PORT_COUNT },
    (_, i) => DISCOVERY_BASE_PORT + i,
  );
  if (!preferred) return band;
  return [preferred, ...band.filter((p) => p !== preferred)];
}

/** Max length of `DEV_TOOL_MCP_NAME` after trim. */
export const INSTANCE_NAME_MAX_LEN = 40;

/** How long the extension waits for Allow/Deny on a control steal. */
export const CONTROL_REQUEST_TIMEOUT_MS = 60_000;

/** Identity of one bridge instance, shown in the popup's Bridges list. */
export type BridgeIdentity = {
  pid: number;
  cwd: string;
  startedAt: number;
  port: number;
  preferredPort: number;
  /** From `DEV_TOOL_MCP_NAME`; display-only, not a unique key. */
  name: string | null;
};

export function parseInstanceName(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, INSTANCE_NAME_MAX_LEN);
}

/** Last path segment of a cwd, used when no instance name is set. */
export function projectOfCwd(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/** Human label: `name :port` (name falls back to the project folder). */
export function instanceLabel(identity: {
  name?: string | null;
  cwd: string;
  port: number;
}): string {
  const name = identity.name?.trim() || projectOfCwd(identity.cwd);
  return `${name} :${identity.port}`;
}

/** Shape returned by GET /health. */
export type BridgeHealth = {
  ok: boolean;
  extensionConnected: boolean;
  /** null until the extension has announced a choice. */
  authorized: boolean | null;
  activePort: number | null;
  identity: BridgeIdentity;
  state: BridgeState;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const PICK_ELEMENT_TIMEOUT_MS = 90_000;
/** Max `waitForMs` for network.list; bridge timeout is waitForMs + slack. */
export const MAX_NETWORK_WAIT_FOR_MS = 300_000;
export const PROTOCOL_VERSION = 1;

export type PinDescriptor = {
  id: string;
  tabId: number;
  url: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  box: { x: number; y: number; width: number; height: number };
  createdAt: number;
};

/** Copyable URI for a pin: `dev-tool-mcp://tab/{tabId}/pin/{id}`. */
export function pinToUri(pin: Pick<PinDescriptor, "id" | "tabId">): string {
  return `dev-tool-mcp://tab/${pin.tabId}/pin/${encodeURIComponent(pin.id)}`;
}

export type BridgeState = {
  extensionConnected: boolean;
  connectedTabId: number | null;
  connectedTabUrl: string | null;
  connectedTabTitle: string | null;
  debuggerAttached: boolean;
};

export type TabInfo = {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
};

export type ConsoleMessage = {
  level: string;
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: number;
};

export type NetworkInitiator = {
  type: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  requestId?: string;
};

export type WebSocketMessageEntry = {
  opcode: number;
  data: string;
  direction: "sent" | "received";
  timestamp: number;
};

export type NetworkEntry = {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  /** CDP resource type (Document, XHR, Fetch, WebSocket, Script, …). */
  type?: string;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Request body when present (truncated in list views). */
  postData?: string;
  initiator?: NetworkInitiator;
  fromCache?: boolean;
  serviceWorkerResponseSource?: string;
  encodedDataLength?: number;
  protocol?: string;
  remoteIPAddress?: string;
  /** CDP target id when the request came from an attached worker/iframe target. */
  targetId?: string;
  /** page | worker | shared_worker | service_worker | iframe | other */
  targetType?: string;
  resourceKind?: "http" | "websocket";
  webSocketMessages?: WebSocketMessageEntry[];
  errorText?: string;
  finished?: boolean;
};

/** Filters for `network.list` / `network.wait` (all fields optional, AND-combined). */
export type NetworkListFilter = {
  /** Substring match on URL (case-insensitive). Legacy alias of `url`. */
  filter?: string;
  url?: string;
  urlRegex?: string;
  method?: string;
  host?: string;
  type?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  /** Only entries with timestamp >= since (ms epoch). */
  since?: number;
  resourceKind?: "http" | "websocket";
  targetType?: string;
  limit?: number;
  /** Include buffered WebSocket frame payloads (can be large). */
  includeWebSocketMessages?: boolean;
  /** Block until a matching request appears or timeout (ms). */
  waitForMs?: number;
};

export type PinInspectResult = {
  id: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  attrs: Record<string, string>;
  text: string;
  nearbyText: string;
  outerHTML: string;
  src: string | null;
  currentSrc: string | null;
  href: string | null;
  backgroundImage: string | null;
  ariaLabel: string | null;
  title: string | null;
  box: { x: number; y: number; width: number; height: number };
  /** How many nodes match the stored selector right now. */
  matchCount: number;
  /** URLs extracted from the element (src, href, css background, …). */
  relatedUrls: string[];
};

export type RpcMethod =
  | "ping"
  | "state.get"
  | "tabs.connect"
  | "tabs.disconnect"
  | "tabs.list"
  | "tabs.open"
  | "tabs.navigate"
  | "tabs.goBack"
  | "tabs.goForward"
  | "tabs.wait"
  | "page.snapshot"
  | "page.find"
  | "page.click"
  | "page.hover"
  | "page.drag"
  | "page.type"
  | "page.pressKey"
  | "page.screenshot"
  | "page.evaluate"
  | "page.pickElement"
  | "page.pickCancel"
  | "pins.list"
  | "pins.clear"
  | "pins.inspect"
  | "debugger.attach"
  | "debugger.detach"
  | "debugger.sendCommand"
  | "debugger.targets"
  | "console.list"
  | "console.clear"
  | "network.list"
  | "network.get"
  | "network.getResponseBody"
  | "network.forPin"
  | "network.summary"
  | "storage.getCookies"
  | "storage.setCookie"
  | "storage.clearCookies"
  | "storage.getLocal"
  | "storage.setLocal"
  | "storage.clearLocal"
  | "storage.getSession"
  | "storage.setSession"
  | "storage.clearSession"
  | "dom.getBoxModel"
  | "dom.getComputedStyle"
  | "control.request"
  | "control.release"
  | "control.status";

/**
 * RPC methods that require the control lease. Read-only inspection and
 * `control.*` itself are excluded so every connected instance can talk.
 */
export const MUTATING_RPC_METHODS: ReadonlySet<string> = new Set([
  "tabs.connect",
  "tabs.disconnect",
  "tabs.open",
  "tabs.navigate",
  "tabs.goBack",
  "tabs.goForward",
  "tabs.wait",
  "page.click",
  "page.hover",
  "page.drag",
  "page.type",
  "page.pressKey",
  "page.screenshot",
  "page.evaluate",
  "page.pickElement",
  "page.pickCancel",
  "pins.clear",
  "debugger.attach",
  "debugger.detach",
  "debugger.sendCommand",
  "storage.setCookie",
  "storage.clearCookies",
  "storage.setLocal",
  "storage.clearLocal",
  "storage.setSession",
  "storage.clearSession",
]);

export function isMutatingRpc(method: string): boolean {
  return MUTATING_RPC_METHODS.has(method);
}

export type ControlChangeReason =
  | "granted"
  | "stolen"
  | "released"
  | "manual"
  | "disconnected";

export type ControlChangedPayload = {
  controllerPort: number | null;
  identity: BridgeIdentity | null;
  reason: ControlChangeReason;
};

export type ControlStatus = {
  controllerPort: number | null;
  controlling: boolean;
  identity: BridgeIdentity | null;
};

export type RequestMessage = {
  type: "request";
  id: string;
  token: string;
  method: RpcMethod | string;
  params?: Record<string, unknown>;
};

export type ResponseMessage = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
};

export type EventName =
  | "state.changed"
  | "console.message"
  | "network.request"
  | "network.response"
  | "debugger.detached"
  | "auth.ready"
  | "control.changed";

export type EventMessage = {
  type: "event";
  event: EventName | string;
  payload?: unknown;
};

export type HelloMessage = {
  type: "hello";
  protocolVersion: number;
  role: "extension";
  token?: string;
};

export type WelcomeMessage = {
  type: "welcome";
  protocolVersion: number;
  token: string;
  port: number;
};

export type BridgeMessage =
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | HelloMessage
  | WelcomeMessage;

export function emptyBridgeState(): BridgeState {
  return {
    extensionConnected: false,
    connectedTabId: null,
    connectedTabUrl: null,
    connectedTabTitle: null,
    debuggerAttached: false,
  };
}
