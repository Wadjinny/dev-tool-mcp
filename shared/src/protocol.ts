import type { BridgeError } from "./errors.js";

export const DEFAULT_WS_PORT = 17373;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const PROTOCOL_VERSION = 1;

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

export type NetworkEntry = {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  type?: string;
  timestamp: number;
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
  | "page.click"
  | "page.hover"
  | "page.drag"
  | "page.type"
  | "page.pressKey"
  | "page.screenshot"
  | "page.evaluate"
  | "debugger.attach"
  | "debugger.detach"
  | "debugger.sendCommand"
  | "console.list"
  | "console.clear"
  | "network.list"
  | "network.getResponseBody"
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
