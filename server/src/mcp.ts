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
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  ErrorCodes,
  MAX_NETWORK_WAIT_FOR_MS,
  PICK_ELEMENT_TIMEOUT_MS,
  SECURE_INPUT_TIMEOUT_MS,
} from "@dev-tool-mcp/shared";

async function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fromThrown(err);
  }
}

function requireRefOrPin(ref?: string, pin?: string): ToolResult | null {
  const hasRef = typeof ref === "string" && ref.length > 0;
  const hasPin = typeof pin === "string" && pin.length > 0;
  if (hasRef === hasPin) {
    return errorResult(
      ErrorCodes.UNKNOWN,
      "Provide exactly one of ref or pin.",
    );
  }
  return null;
}

/** Sent to clients at initialize; agents see it when choosing tools. */
export const SERVER_INSTRUCTIONS = `Controls the user's real Google Chrome (their profile, logins and cookies) through the dev-tool-mcp extension.

Use it whenever a task needs a web browser, not only for debugging:
- browse, search, read or summarize web pages, including pages behind the user's logins that plain web fetch cannot reach;
- fill in forms, click through web apps, download or check things on websites;
- test or debug a web app (DevTools: network, console, DOM, cookies, storage).

Chrome need not be open: if it is closed when a browser tool is called, the server launches it with the user's normal profile (so the installed extension and its permissions apply) and waits for the extension to connect. If the extension still does not connect, ask the user to enable dev-tool-mcp in chrome://extensions.

Workflow: browser_open(url) -> browser_snapshot (refs like e3) -> browser_click / browser_type / browser_press_key with those refs (they wait for any navigation they trigger) -> browser_snapshot again to verify, or browser_screenshot to see the page. Use devtools_* tools for network, console and DOM details; pass recordNetwork:true to browser_open to capture the page's own load.

Secrets: never ask the user to paste a password, OTP, API key or other secret into the chat, and never pass one as browser_type text. Call browser_type_secure on the field instead: the user types it in a secure extension window, the extension types it straight into the page, and you only receive { filled, chars, submitted }. Values entered that way are redacted from later snapshots.

Etiquette:
- Each MCP session controls its own tab, marked in Chrome with a coloured tab group and border. browser_open replaces your previous tab; other sessions' tabs are not yours.
- To work in a tab the user already has open, call browser_tabs({includeOthers:true}) then browser_connect_tab(tabId); the user must click Allow in a Chrome notification (60s).
- Screenshots need the tab in front (open with active:true).
- Call browser_disconnect when you are done with the browser.`;

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "dev-tool-mcp",
      title: "Chrome browser (dev-tool-mcp)",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // --- Session / tab ownership ---
  // Each MCP session owns its own Connected tab, so sessions run in parallel.

  server.tool(
    "browser_connect_tab",
    "Take over an existing Chrome tab (id from browser_tabs includeOthers) as this session's Connected tab. Always asks the user to Allow via a Chrome notification; replaces this session's previous Connected tab.",
    { tabId: z.number().int().describe("Tab id from browser_tabs") },
    async ({ tabId }) =>
      wrap(async () =>
        textResult(
          await callExt(
            "tabs.connect",
            { tabId },
            CONTROL_REQUEST_TIMEOUT_MS + 5_000,
          ),
        ),
      ),
  );

  server.tool(
    "browser_disconnect",
    "Release this session's Connected tab (removes its tab group, border and badge; detaches the debugger).",
    {},
    async () =>
      wrap(async () => textResult(await callExt("tabs.disconnect"))),
  );

  server.tool(
    "browser_request_control",
    "Legacy: no lease is needed any more because each session owns its own Connected tab. Returns this session's status (same as browser_control_status).",
    {},
    async () =>
      wrap(async () =>
        textResult(
          await callExt(
            "control.request",
            {},
            CONTROL_REQUEST_TIMEOUT_MS + 5_000,
          ),
        ),
      ),
  );

  server.tool(
    "browser_release_control",
    "Legacy alias of browser_disconnect: release this session's Connected tab.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("control.release"))),
  );

  server.tool(
    "browser_control_status",
    "This session's identity and Connected tab, plus which tabs other MCP sessions are controlling.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("control.status"))),
  );

  // --- Automation ---

  server.tool(
    "browser_tabs",
    "List this session's Connected tab and optionally other open tabs (read-only; others show connectedBy when another session owns them). Use browser_open to create a tab, or browser_connect_tab to take over an existing one.",
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
    "browser_open",
    "Open a web page in the user's real Chrome (with their logins) to browse, read or interact with it. Creates a new tab that becomes this session's Connected tab, replacing any previous one. Start here for any task that needs a browser. Restricted URLs (chrome://, Web Store, …) are rejected.",
    {
      url: z.string().url().describe("Absolute URL to open"),
      active: z
        .boolean()
        .optional()
        .describe("Focus the new tab (default true). Background tabs cannot be screenshotted."),
      recordNetwork: z
        .boolean()
        .optional()
        .describe(
          "Attach the debugger before loading so devtools_network_* includes the page's own initial requests (default false; Chrome shows its 'debugging this browser' bar).",
        ),
    },
    async ({ url, active, recordNetwork }) =>
      wrap(async () =>
        textResult(
          await callExt(
            "tabs.open",
            { url, active: active ?? true, recordNetwork: recordNetwork ?? false },
            45_000,
          ),
        ),
      ),
  );

  server.tool(
    "browser_navigate",
    "Navigate this session's Connected tab to a URL. If it has none, opens a new tab and Connects it (same as browser_open).",
    {
      url: z.string().url().describe("Absolute URL to open"),
      recordNetwork: z
        .boolean()
        .optional()
        .describe("Attach the debugger first so the navigation's requests are captured (default false)"),
    },
    async ({ url, recordNetwork }) =>
      wrap(async () =>
        textResult(
          await callExt(
            "tabs.navigate",
            { url, recordNetwork: recordNetwork ?? false },
            45_000,
          ),
        ),
      ),
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
    "Press a key on the Connected page (e.g. Enter, Escape, Tab, a). If it starts a navigation, waits for it to finish and returns navigated/url.",
    {
      key: z.string().describe("Key name"),
      waitForNavigation: z
        .boolean()
        .optional()
        .describe("Wait for a navigation triggered by the key (default true)"),
    },
    async ({ key, waitForNavigation }) =>
      wrap(async () =>
        textResult(
          await callExt("page.pressKey", { key, waitForNavigation }, 45_000),
        ),
      ),
  );

  server.tool(
    "browser_snapshot",
    "Read the current page: an accessibility snapshot of the Connected tab (main frame + iframes) listing interactive elements with their state (value, checked, …) and ref handles for browser_click / browser_type. Main-frame refs look like e3; iframe refs look like f1842.e3. May include frames[] metadata and a warning when the main frame is shell-only.",
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
    "browser_find",
    "Find elements across the Connected page and its iframes by accessible name/text. Returns clickable refs (eN or f{frameId}.eN).",
    {
      query: z.string().describe("Case-insensitive substring to match"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max matches (default 20)"),
    },
    async ({ query, limit }) =>
      wrap(async () =>
        textResult(
          await callExt("page.find", {
            query,
            limit: limit ?? 20,
          }),
        ),
      ),
  );

  server.tool(
    "browser_click",
    "Click an element by snapshot/find ref (eN or f{frameId}.eN) or pin from browser_pick_element / browser_pins. If the click starts a navigation, waits for it to finish and returns navigated/url (take a fresh snapshot afterwards).",
    {
      ref: z
        .string()
        .optional()
        .describe("Ref from browser_snapshot / browser_find (eN or f{frameId}.eN)"),
      pin: z.string().optional().describe("Pin id from browser_pick_element"),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
      waitForNavigation: z
        .boolean()
        .optional()
        .describe("Wait for a navigation triggered by the click (default true; adds ~0.4s when none starts)"),
    },
    async ({ ref, pin, button, doubleClick, waitForNavigation }) =>
      wrap(async () => {
        const bad = requireRefOrPin(ref, pin);
        if (bad) return bad;
        return textResult(
          await callExt(
            "page.click",
            { ref, pin, button, doubleClick, waitForNavigation },
            45_000,
          ),
        );
      }),
  );

  server.tool(
    "browser_hover",
    "Hover an element by snapshot/find ref (eN or f{frameId}.eN) or pin.",
    {
      ref: z.string().optional().describe("Ref eN or f{frameId}.eN"),
      pin: z.string().optional(),
    },
    async ({ ref, pin }) =>
      wrap(async () => {
        const bad = requireRefOrPin(ref, pin);
        if (bad) return bad;
        return textResult(await callExt("page.hover", { ref, pin }));
      }),
  );

  server.tool(
    "browser_drag",
    "Drag between snapshot refs and/or pins (same frame only for f{frameId}.eN refs).",
    {
      startRef: z.string().optional().describe("Ref eN or f{frameId}.eN"),
      endRef: z.string().optional().describe("Ref eN or f{frameId}.eN"),
      startPin: z.string().optional(),
      endPin: z.string().optional(),
    },
    async ({ startRef, endRef, startPin, endPin }) =>
      wrap(async () => {
        const startBad = requireRefOrPin(startRef, startPin);
        if (startBad) return startBad;
        const endBad = requireRefOrPin(endRef, endPin);
        if (endBad) return endBad;
        return textResult(
          await callExt("page.drag", {
            startRef,
            endRef,
            startPin,
            endPin,
          }),
        );
      }),
  );

  server.tool(
    "browser_type",
    "Type text into an element by snapshot/find ref (eN or f{frameId}.eN) or pin. With submit, waits for a resulting navigation. Never pass passwords, OTPs, API keys or other secrets here — use browser_type_secure.",
    {
      ref: z.string().optional().describe("Ref eN or f{frameId}.eN"),
      pin: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      slowly: z.boolean().optional(),
      waitForNavigation: z
        .boolean()
        .optional()
        .describe("When submit is set, wait for the navigation it triggers (default true)"),
    },
    async ({ ref, pin, text, submit, slowly, waitForNavigation }) =>
      wrap(async () => {
        const bad = requireRefOrPin(ref, pin);
        if (bad) return bad;
        return textResult(
          await callExt(
            "page.type",
            { ref, pin, text, submit, slowly, waitForNavigation },
            45_000,
          ),
        );
      }),
  );

  server.tool(
    "browser_type_secure",
    "Type a secret (password, OTP, API key) into an element without the value ever entering this conversation or the tool log. Opens a secure extension window where the user types it; the extension types it straight into the page. Blocks until submit, cancel, or timeout; returns only { filled, chars, submitted } (never the value). Use this instead of asking the user for a secret in chat.",
    {
      ref: z.string().optional().describe("Ref eN or f{frameId}.eN"),
      pin: z.string().optional(),
      label: z
        .string()
        .optional()
        .describe("What is being asked, e.g. 'LinkedIn password' (shown in the window)"),
      kind: z
        .enum(["password", "text", "otp"])
        .optional()
        .describe("Input style in the secure window (default password)"),
      targetHint: z
        .string()
        .optional()
        .describe("Name of the target field, e.g. 'Mot de passe'"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter / submit the form after typing"),
      waitForNavigation: z
        .boolean()
        .optional()
        .describe("When submit is set, wait for the navigation it triggers (default true)"),
      timeoutMs: z
        .number()
        .int()
        .min(5_000)
        .max(300_000)
        .optional()
        .describe(`How long to wait for the user (default ${SECURE_INPUT_TIMEOUT_MS} ms)`),
    },
    async ({ ref, pin, label, kind, targetHint, submit, waitForNavigation, timeoutMs }) =>
      wrap(async () => {
        const bad = requireRefOrPin(ref, pin);
        if (bad) return bad;
        return textResult(
          await callExt(
            "page.typeSecure",
            {
              ref,
              pin,
              label,
              kind,
              targetHint,
              submit,
              waitForNavigation,
              timeoutMs,
            },
            (timeoutMs ?? SECURE_INPUT_TIMEOUT_MS) + 15_000,
          ),
        );
      }),
  );

  server.tool(
    "browser_pick_element",
    "Ask the user to click an element on the Connected tab. Blocks until pick, Esc cancel, or timeout (default 90s).",
    {
      prompt: z
        .string()
        .optional()
        .describe("Short instruction shown in the page banner"),
    },
    async ({ prompt }) =>
      wrap(async () =>
        textResult(
          await callExt(
            "page.pickElement",
            { prompt },
            PICK_ELEMENT_TIMEOUT_MS + 5_000,
          ),
        ),
      ),
  );

  server.tool(
    "browser_pick_cancel",
    "Cancel an in-progress element pick on the Connected tab.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("page.pickCancel"))),
  );

  server.tool(
    "browser_pins",
    "List pinned elements on the Connected tab.",
    {},
    async () => wrap(async () => textResult(await callExt("pins.list"))),
  );

  server.tool(
    "browser_pin_inspect",
    "Inspect a pinned element: attrs, src/href, nearby text, outerHTML, related URLs for network correlation.",
    {
      pin: z.string().describe("Pin id (e.g. pin_1)"),
    },
    async ({ pin }) =>
      wrap(async () => textResult(await callExt("pins.inspect", { pin }))),
  );

  server.tool(
    "browser_pin_clear",
    "Clear one pinned element by id, or all pins if id is omitted.",
    {
      id: z.string().optional().describe("Pin id (e.g. pin_1)"),
    },
    async ({ id }) =>
      wrap(async () => textResult(await callExt("pins.clear", { id }))),
  );

  server.tool(
    "browser_screenshot",
    "Capture a screenshot of the Connected tab. The tab must be in front of its window (fails fast with TAB_NOT_VISIBLE otherwise). The agent indicator overlay is hidden during capture.",
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
    "Attach chrome.debugger (CDP) to the Connected tab. Also attaches related existing workers (worker/shared_worker/service_worker) via chrome.debugger.getTargets and enables Network on them.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("debugger.attach"))),
  );

  server.tool(
    "devtools_detach",
    "Detach chrome.debugger from the Connected tab and any worker targets attached by this extension.",
    {},
    async () =>
      wrap(async () => textResult(await callExt("debugger.detach"))),
  );

  server.tool(
    "devtools_targets",
    "List the Connected tab page target and related worker/shared_worker/service_worker targets (from chrome.debugger.getTargets), including whether each is attached.",
    {},
    async () =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(await callExt("debugger.targets"));
      }),
  );

  server.tool(
    "devtools_network_requests",
    "List buffered CDP network requests (HTTP + WebSocket) for this session's tab. Auto-attaches debugger. Buffer only fills after attach (use browser_open/browser_navigate with recordNetwork:true to include the initial page load); existing related workers are attached on attach, new ones via Target.setAutoAttach.",
    {
      filter: z
        .string()
        .optional()
        .describe("Legacy URL substring filter (same as url)"),
      url: z.string().optional().describe("URL substring (case-insensitive)"),
      urlRegex: z.string().optional().describe("URL regex (case-insensitive)"),
      method: z.string().optional().describe("HTTP method, e.g. GET/POST/PUT"),
      host: z.string().optional().describe("Exact URL host match"),
      type: z
        .string()
        .optional()
        .describe("CDP resource type, e.g. XHR, Fetch, Script, WebSocket"),
      status: z.number().int().optional(),
      statusMin: z.number().int().optional(),
      statusMax: z.number().int().optional(),
      since: z
        .number()
        .optional()
        .describe("Only entries with timestamp >= since (ms epoch)"),
      resourceKind: z.enum(["http", "websocket"]).optional(),
      targetType: z
        .string()
        .optional()
        .describe("page | worker | service_worker | shared_worker | iframe"),
      limit: z.number().int().positive().optional(),
      includeWebSocketMessages: z
        .boolean()
        .optional()
        .describe("Include buffered WS frame payloads"),
      waitForMs: z
        .number()
        .int()
        .positive()
        .max(MAX_NETWORK_WAIT_FOR_MS)
        .optional()
        .describe(
          `Block until a NEW matching request appears (uses since=now unless since is set). Max ${MAX_NETWORK_WAIT_FOR_MS}ms; returns timedOut:true on expiry.`,
        ),
    },
    async (args) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        const timeoutMs =
          typeof args.waitForMs === "number"
            ? args.waitForMs + 10_000
            : undefined;
        return textResult(await callExt("network.list", args, timeoutMs));
      }),
  );

  server.tool(
    "devtools_network_summary",
    "Compact summary of the network buffer (hosts, top paths with id-like segments collapsed to :id, target types, websockets). Auto-attaches debugger. Use for discovery before fetching full request lists.",
    {
      since: z
        .number()
        .optional()
        .describe("Only entries with timestamp >= since (ms epoch)"),
      limitHosts: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max hosts to return (default 15)"),
      limitPaths: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max path aggregates to return (default 15)"),
    },
    async (args) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(await callExt("network.summary", args));
      }),
  );

  server.tool(
    "devtools_network_request",
    "Get full details for one buffered network request (headers, postData, initiator, WS frames).",
    { requestId: z.string() },
    async ({ requestId }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(await callExt("network.get", { requestId }));
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
    "devtools_network_for_pin",
    "Correlate a pin with buffered network requests using the element's related URLs (src, href, css backgrounds).",
    {
      pin: z.string().describe("Pin id from browser_pins / browser_pick_element"),
      limit: z.number().int().positive().optional(),
      includeWebSocketMessages: z.boolean().optional(),
    },
    async ({ pin, limit, includeWebSocketMessages }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("network.forPin", {
            pin,
            limit,
            includeWebSocketMessages,
          }),
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
    "Evaluate JavaScript in the Connected tab (optionally a specific iframe). Optional pin binds the element as `el`. Isolated world auto-falls back to CDP main world on CSP unsafe-eval errors.",
    {
      expression: z
        .string()
        .describe(
          "JS expression. When pin is set, the pinned element is available as `el`.",
        ),
      world: z
        .enum(["isolated", "main"])
        .optional()
        .describe("Default isolated; main uses CDP Runtime.evaluate"),
      awaitPromise: z.boolean().optional(),
      pin: z
        .string()
        .optional()
        .describe("Pin id — expression is evaluated with `el` bound to that node"),
      frame: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe(
          "Chrome frameId (number) or substring match against frame url/name from browser_snapshot frames list",
        ),
    },
    async ({ expression, world, awaitPromise, pin, frame }) =>
      wrap(async () => {
        const useMain = world === "main";
        if (useMain) await ensureDevtoolsAttached();
        return textResult(
          await callExt("page.evaluate", {
            expression,
            world: world ?? "isolated",
            awaitPromise: awaitPromise ?? true,
            pin,
            frame,
          }),
        );
      }),
  );

  server.tool(
    "devtools_get_box_model",
    "Get box model / bounding rect for a ref, pin, or CSS selector.",
    {
      ref: z.string().optional(),
      pin: z.string().optional(),
      selector: z.string().optional(),
    },
    async ({ ref, pin, selector }) =>
      wrap(async () => {
        if (ref || pin) {
          const bad = requireRefOrPin(ref, pin);
          if (bad) return bad;
          return textResult(
            await callExt("dom.getBoxModel", { ref, pin }),
          );
        }
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("dom.getBoxModel", { selector }),
        );
      }),
  );

  server.tool(
    "devtools_get_computed_style",
    "Get computed styles for a ref, pin, or CSS selector.",
    {
      ref: z.string().optional(),
      pin: z.string().optional(),
      selector: z.string().optional(),
      properties: z.array(z.string()).optional(),
    },
    async ({ ref, pin, selector, properties }) =>
      wrap(async () => {
        await ensureDevtoolsAttached();
        return textResult(
          await callExt("dom.getComputedStyle", {
            ref,
            pin,
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
    "Raw allowlisted CDP command on the Connected tab. Domains include Runtime/Network/DOM/Page/Target (read-mostly). Mutating Target/Browser methods are denied.",
    {
      method: z
        .string()
        .describe("CDP method, e.g. Runtime.evaluate or Target.getTargets"),
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
