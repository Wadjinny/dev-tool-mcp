export const ErrorCodes = {
  EXTENSION_DISCONNECTED: "EXTENSION_DISCONNECTED",
  NO_CONNECTED_TAB: "NO_CONNECTED_TAB",
  TAB_GONE: "TAB_GONE",
  RESTRICTED_URL: "RESTRICTED_URL",
  DEBUGGER_ATTACH_FAILED: "DEBUGGER_ATTACH_FAILED",
  DEBUGGER_NOT_ATTACHED: "DEBUGGER_NOT_ATTACHED",
  CDP_METHOD_DENIED: "CDP_METHOD_DENIED",
  CONTENT_SCRIPT_FAILED: "CONTENT_SCRIPT_FAILED",
  TIMEOUT: "TIMEOUT",
  INVALID_REF: "INVALID_REF",
  INVALID_PIN: "INVALID_PIN",
  PICK_CANCELLED: "PICK_CANCELLED",
  PICK_TIMEOUT: "PICK_TIMEOUT",
  PICK_IN_PROGRESS: "PICK_IN_PROGRESS",
  UNAUTHORIZED: "UNAUTHORIZED",
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type BridgeError = {
  code: ErrorCode;
  message: string;
};

export function bridgeError(code: ErrorCode, message: string): BridgeError {
  return { code, message };
}

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  EXTENSION_DISCONNECTED:
    "Extension is not connected. Load the unpacked extension and ensure the MCP server is running.",
  NO_CONNECTED_TAB:
    "No tab Connected in the extension popup. Open the dev-tool-mcp popup and click Connect on the target tab.",
  TAB_GONE: "The Connected tab was closed.",
  RESTRICTED_URL:
    "This URL cannot be Connected (chrome://, extension pages, Web Store, etc.).",
  DEBUGGER_ATTACH_FAILED:
    "Failed to attach the debugger. Close DevTools on that tab and retry.",
  DEBUGGER_NOT_ATTACHED: "Debugger is not attached to the Connected tab.",
  CDP_METHOD_DENIED: "This CDP method is not allowlisted.",
  CONTENT_SCRIPT_FAILED: "Content script injection or automation helper failed.",
  TIMEOUT: "Request timed out.",
  INVALID_REF: "Snapshot ref is missing or stale. Take a new browser_snapshot.",
  INVALID_PIN:
    "Pin is missing or stale. Pick the element again or use a fresh snapshot ref.",
  PICK_CANCELLED: "Element pick was cancelled.",
  PICK_TIMEOUT: "Element pick timed out before a selection was made.",
  PICK_IN_PROGRESS: "An element pick is already in progress.",
  UNAUTHORIZED: "Handshake token mismatch.",
  UNKNOWN: "Unknown error.",
};
