import type { BridgeError } from "./errors.js";

export const DEFAULT_WS_PORT = 17373;
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
  | "dom.getComputedStyle";

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
  | "auth.ready";

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
