import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertCdpAllowed,
  callExt,
  ensureDevtoolsAttached,
  errorResult,
  fromThrown,
  textResult,
  type ToolResult,
} from "./tools/helpers.js";
import { getBridge } from "./ws-bridge.js";
import { ErrorCodes } from "@dev-tool-mcp/shared";

async function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fromThrown(err);
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "dev-tool-mcp",
    version: "0.1.0",
  });

  // --- Automation ---

  server.tool(
    "browser_tabs",
    "List the Connected tab and optionally other open tabs (read-only). Connecting tabs is done in the extension popup.",
    {
      includeOthers: z.boolean().optional().describe("Include other open tabs"),
    },
    async ({ includeOthers }) =>
      wrap(async () => {
        const result = await callExt("tabs.list", {
          includeOthers: includeOthers ?? false,
        });
        return textResult(result);
      }),
  );

  server.tool(
    "browser_navigate",
    "Navigate the Connected tab to a URL.",
    { url: z.string().url().describe("Absolute URL to open") },
    async ({ url }) =>
      wrap(async () => textResult(await callExt("tabs.navigate", { url }))),
  );

  server.tool(
    "browser_go_back",
    "Go back in history on the Connected tab.",
    {},
    async () => wrap(async () => textResult(await callExt("tabs.goBack"))),
  );

  server.tool(
    "browser_go_forward",
    "Go forward in history on the Connected tab.",
    {},
    async () => wrap(async () => textResult(await callExt("tabs.goForward"))),
  );

  server.tool(
    "browser_wait",
    "Wait for a duration and/or load state on the Connected tab.",
    {
      time: z.number().optional().describe("Milliseconds to wait"),
      load: z
        .enum(["complete", "domcontentloaded"])
        .optional()
        .describe("Wait for document load state"),
    },
    async ({ time, load }) =>
      wrap(async () =>
        textResult(await callExt("tabs.wait", { time, load })),
      ),
  );

  server.tool(
    "browser_press_key",
    "Press a key on the Connected page (e.g. Enter, Escape, Tab, a).",
    { key: z.string().describe("Key name") },
    async ({ key }) =>
      wrap(async () => textResult(await callExt("page.pressKey", { key }))),
  );

  server.tool(
    "browser_snapshot",
    "Accessibility snapshot of the Connected page with ref handles for interaction.",
    {
      interestingOnly: z
        .boolean()
        .optional()
        .describe("Only include interesting interactive nodes"),
    },
    async ({ interestingOnly }) =>
      wrap(async () =>
        textResult(
          await callExt("page.snapshot", {
            interestingOnly: interestingOnly ?? true,
          }),
        ),
      ),
  );

  server.tool(
    "browser_click",
    "Click an element by snapshot ref.",
    {
      ref: z.string().describe("Ref from browser_snapshot"),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
    },
    async ({ ref, button, doubleClick }) =>
      wrap(async () =>
        textResult(
          await callExt("page.click", { ref, button, doubleClick }),
        ),
      ),
  );

  server.tool(
    "browser_hover",
    "Hover an element by snapshot ref.",
    { ref: z.string() },
    async ({ ref }) =>
      wrap(async () => textResult(await callExt("page.hover", { ref }))),
  );

  server.tool(
    "browser_drag",
    "Drag from startRef to endRef.",
    {
      startRef: z.string(),
      endRef: z.string(),
    },
    async ({ startRef, endRef }) =>
      wrap(async () =>
        textResult(await callExt("page.drag", { startRef, endRef })),
      ),
  );

  server.tool(
    "browser_type",
    "Type text into an element by snapshot ref.",
    {
      ref: z.string(),
      text: z.string(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
    },
    async ({ ref, text, submit, slowly }) =>
      wrap(async () =>
        textResult(await callExt("page.type", { ref, text, submit, slowly })),
      ),
  );

  server.tool(
    "browser_screenshot",
    "Capture a screenshot of the Connected tab.",
    {
      fullPage: z
        .boolean()
        .optional()
        .describe("Best-effort full page (may use CDP)"),
    },
    async ({ fullPage }) =>
      wrap(async () => {
        const result = (await callExt("page.screenshot", {
          fullPage: fullPage ?? false,
        })) as { mimeType: string; base64: string };
        return {
          content: [
            {
              type: "image" as const,
              data: result.base64,
              mimeType: result.mimeType || "image/png",
            },
          ],
        };
      }),
  );

  server.tool(
    "browser_console_messages",
    "Return buffered console messages (CDP when debugger attached).",
    { clear: z.boolean().optional() },
    async ({ clear }) =>
      wrap(async () => {
        const bridge = getBridge();
        let messages = bridge.getConsoleBuffer();
        try {
          const fromExt = (await callExt("console.list", {
            clear: clear ?? false,
          })) as { messages?: unknown[] };
          if (fromExt.messages) messages = fromExt.messages;
        } catch {
          // use local buffer
        }
        if (clear) bridge.clearConsoleBuffer();
        return textResult({
          messages,
          note:
            messages.length === 0
              ? "Buffer empty. Call devtools_attach or any devtools_* tool first to capture CDP console events."
              : undefined,
        });
      }),
  );

  // --- DevTools ---

  server.tool(
    "devtools_attach",
    "Attach chrome.debugger (CDP) to the Connected tab.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("debugger.attach"))),
  );

  server.tool(
    "devtools_detach",
    "Detach chrome.debugger from the Connected tab.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("debugger.detach"))),
  );

  server.tool(
    "devtools_network_requests",
    "List buffered network requests from CDP.",
    {
      filter: z.string().optional().describe("Substring filter on URL"),
      limit: z.number().int().positive().optional(),
    },
    async ({ filter, limit }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("network.list", { filter, limit }),
        );
      }),
  );

  server.tool(
    "devtools_network_body",
    "Get response body for a network request id.",
    { requestId: z.string() },
    async ({ requestId }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("network.getResponseBody", { requestId }),
        );
      }),
  );

  server.tool(
    "devtools_console_messages",
    "Console messages via CDP buffer only.",
    { clear: z.boolean().optional() },
    async ({ clear }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(await callExt("console.list", { clear }));
      }),
  );

  server.tool(
    "devtools_evaluate",
    "Evaluate JavaScript in the Connected tab.",
    {
      expression: z.string(),
      world: z.enum(["isolated", "main"]).optional(),
      awaitPromise: z.boolean().optional(),
    },
    async ({ expression, world, awaitPromise }) =>
      wrap(async () => {
        if (world === "main") {
          await ensureDevtoolsAttached();
          return textResult(
            await callExt("page.evaluate", {
              expression,
              world: "main",
              awaitPromise: awaitPromise ?? true,
            }),
          );
        }
        return textResult(
          await callExt("page.evaluate", {
            expression,
            world: world ?? "isolated",
            awaitPromise: awaitPromise ?? true,
          }),
        );
      }),
  );

  server.tool(
    "devtools_get_box_model",
    "Get box model / bounding rect for a ref or CSS selector.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
    },
    async ({ ref, selector }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("dom.getBoxModel", { ref, selector }),
        );
      }),
  );

  server.tool(
    "devtools_get_computed_style",
    "Get computed styles for a ref or CSS selector.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      properties: z.array(z.string()).optional(),
    },
    async ({ ref, selector, properties }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("dom.getComputedStyle", {
            ref,
            selector,
            properties,
          }),
        );
      }),
  );

  server.tool(
    "devtools_cookies",
    "Get, set, or clear cookies for the Connected origin.",
    {
      action: z.enum(["get", "set", "clear"]),
      cookie: z
        .object({
          name: z.string(),
          value: z.string().optional(),
          url: z.string().optional(),
          domain: z.string().optional(),
          path: z.string().optional(),
          secure: z.boolean().optional(),
          httpOnly: z.boolean().optional(),
          sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          expirationDate: z.number().optional(),
        })
        .optional(),
    },
    async ({ action, cookie }) =>
      wrap(async () => {
        if (action === "get") {
          return textResult(await callExt("storage.getCookies"));
        }
        if (action === "set") {
          if (!cookie?.name || cookie.value === undefined) {
            return errorResult(
              ErrorCodes.UNKNOWN,
              "cookie.name and cookie.value are required for set",
            );
          }
          return textResult(await callExt("storage.setCookie", { cookie }));
        }
        return textResult(await callExt("storage.clearCookies"));
      }),
  );

  server.tool(
    "devtools_storage",
    "Read/write localStorage or sessionStorage on the Connected origin.",
    {
      store: z.enum(["local", "session"]),
      action: z.enum(["get", "set", "clear"]),
      key: z.string().optional(),
      value: z.string().optional(),
    },
    async ({ store, action, key, value }) =>
      wrap(async () => {
        const method =
          store === "local"
            ? action === "get"
              ? "storage.getLocal"
              : action === "set"
                ? "storage.setLocal"
                : "storage.clearLocal"
            : action === "get"
              ? "storage.getSession"
              : action === "set"
                ? "storage.setSession"
                : "storage.clearSession";
        return textResult(await callExt(method, { key, value }));
      }),
  );

  server.tool(
    "devtools_cdp",
    "Raw allowlisted CDP command on the Connected tab.",
    {
      method: z.string().describe("CDP method, e.g. Runtime.evaluate"),
      params: z.record(z.unknown()).optional(),
    },
    async ({ method, params }) =>
      wrap(async () => {
        const denied = assertCdpAllowed(method);
        if (denied) return denied;
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("debugger.sendCommand", {
            method,
            params: params ?? {},
          }),
        );
      }),
  );

  return server;
}
