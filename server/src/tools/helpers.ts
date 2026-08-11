import {
  ErrorCodes,
  ERROR_MESSAGES,
  isCdpMethodAllowed,
  type ErrorCode,
} from "@dev-tool-mcp/shared";
import { getBridge } from "../ws-bridge.js";

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function textResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function errorResult(code: ErrorCode, message?: string): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code,
          message: message ?? ERROR_MESSAGES[code],
        }),
      },
    ],
  };
}

export function fromThrown(err: unknown): ToolResult {
  const e = err as { code?: string; message?: string };
  const code = (e.code as ErrorCode) || ErrorCodes.UNKNOWN;
  return errorResult(code, e.message ?? ERROR_MESSAGES[code] ?? String(err));
}

export async function callExt(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return getBridge().request(method, params);
}

export async function ensureDevtoolsAttached(): Promise<void> {
  const state = getBridge().getState();
  if (state.debuggerAttached) return;
  await callExt("debugger.attach");
}

export function assertCdpAllowed(method: string): ToolResult | null {
  if (!isCdpMethodAllowed(method)) {
    return errorResult(
      ErrorCodes.CDP_METHOD_DENIED,
      `CDP method not allowlisted: ${method}`,
    );
  }
  return null;
}
