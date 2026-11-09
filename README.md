# dev-tool-mcp

Chrome Manifest V3 extension + TypeScript MCP server that lets an AI agent automate and inspect your **real Chrome profile**, gated by an explicit per-tab **Connect** control. Hybrid page automation (content scripts) plus DevTools depth via `chrome.debugger` (CDP).

See [SPEC.md](./SPEC.md) for architecture, protocol, and tool catalog.

## Download

A prebuilt extension zip (`dev-tool-mcp-extension-*.zip`) is attached to each [release](https://github.com/Wadjinny/dev-tool-mcp/releases/latest). Unzip it and load the folder with **Load unpacked** in `chrome://extensions`. You still need to build and run the MCP server from source (step 1 and 2 below).

## Setup

### 1. Install and build

```bash
pnpm install
pnpm build
```

### 2. Run the MCP server (Cursor)

Add to your Cursor MCP config (absolute path required):

```json
{
  "mcpServers": {
    "dev-tool-mcp": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/dev-tool-mcp/server",
        "exec",
        "tsx",
        "src/index.ts"
      ],
      "env": {
        "DEV_TOOL_MCP_WS_PORT": "17373",
        "DEV_TOOL_MCP_NAME": "vidfast-dl"
      }
    }
  }
}
```

Or after `pnpm build`:

```json
{
  "mcpServers": {
    "dev-tool-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/dev-tool-mcp/server/dist/index.js"],
      "env": {
        "DEV_TOOL_MCP_WS_PORT": "17373",
        "DEV_TOOL_MCP_NAME": "vidfast-dl"
      }
    }
  }
}
```

The server listens on `ws://127.0.0.1:17373` only (never `0.0.0.0`). Each instance keeps its own handshake token (`~/.config/dev-tool-mcp/token`, or `DEV_TOOL_MCP_TOKEN` / `DEV_TOOL_MCP_TOKEN_FILE`). The extension fetches **that instance’s** token from `http://127.0.0.1:<port>/handshake` — instances do not need to share a file.

Optional `DEV_TOOL_MCP_NAME` is the label shown in the popup and in control-request notifications (falls back to the project folder name). Always combined with `:port`.

Up to **20** instances can bind in the discovery band `17373–17392`. The extension opens a WebSocket to each and keeps them all connected.

### Chrome does not need to be running

If Chrome is closed when a browser tool is called, the server launches it with your normal profile — so the installed extension keeps its granted permissions — waits for the extension to connect (up to ~25 s), then runs the tool. If Chrome is already running but the extension has not connected yet, it waits for the extension to reconnect instead of opening another window.

All of this is optional to configure:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_TOOL_MCP_LAUNCH_CHROME` | on | Set to `0`/`false`/`off` to never launch Chrome automatically. |
| `DEV_TOOL_MCP_CHROME_BIN` | auto-detected | Browser executable, e.g. `/usr/bin/google-chrome`. |
| `DEV_TOOL_MCP_CHROME_PROFILE` | Chrome's default | `--profile-directory` value, e.g. `Default` or `Profile 1`. |
| `DEV_TOOL_MCP_CHROME_USER_DATA_DIR` | Chrome's default | `--user-data-dir`, for a separate profile. |
| `DEV_TOOL_MCP_CHROME_ARGS` | none | Extra flags, e.g. `--start-maximized`. |
| `DEV_TOOL_MCP_CHROME_EXTENSION` | none | Unpacked extension folder to force-load with `--load-extension` (Chromium / Chrome for Testing). |
| `DEV_TOOL_MCP_CHROME_CONNECT_TIMEOUT_MS` | `25000` | How long to wait for the extension after launching. |

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`
4. Chrome will warn about the `debugger` permission. Access is limited to the tab you Connect and a local MCP server.

### 4. Connect a tab

Either:

- Open the site in Chrome, click the **dev-tool-mcp** icon, then **Connect this tab**, or
- Ask the agent to `browser_open` / `browser_navigate` a URL (creates a tab and Connects it), or
- Ask the agent to `browser_connect_tab` an existing tab (id from `browser_tabs` with `includeOthers`); you Allow it in a Chrome notification

Restricted URLs (`chrome://`, extension pages, Web Store) cannot be opened or Connected.

### Several sessions in parallel

Every MCP session (Claude Code, Cursor, …) owns **its own** Connected tab, so several agents can work side by side without prompts or a shared lease:

- Each session has at most one tab; `browser_open` / `browser_connect_tab` replace that session's previous tab.
- Network/console buffers, pins and the element picker are per tab, and CDP events are sent only to the owning session.
- Taking over an existing tab (`browser_connect_tab`) always asks you to **Allow**. If another session owns it, the notification says so.
- The popup **Connect this tab** card gives the active tab to the session marked **Connect target** (click another session card to change it). The only connected session is picked automatically. Commands in the popup (Stop, Pick element, Hand this tab, Detach debugger) also run from the keyboard.
- If a session's MCP server goes away, its tab is released after 60 s (restarts within that window keep the tab). A new process reusing the port does not inherit the old process's tab.
- `browser_request_control` / `browser_release_control` remain as legacy aliases (status / disconnect).

Disconnect (popup, pill **Stop**, or `browser_disconnect`) releases the tab and detaches the debugger.

### Controlled-tab indicator

Every Connected tab is visibly marked (similar to Claude in Chrome), in a colour per session:

- It moves into a **🤖 `name :port`** tab group in that session's colour (tabs already in one of your own groups are left where they are) and leaves the group on Disconnect.
- The page gets a matching border and a bottom pill, "`name :port` is controlling this tab", with **Stop** (Disconnect) and collapse buttons. The border pulses while an agent command runs.
- The toolbar badge shows **ON** only on Connected tabs.

The overlay sits in a closed shadow root outside `<body>`, so snapshots and find don't see it. It is hidden while screenshots are taken.

### Navigation-aware actions and network recording

- `browser_click`, `browser_press_key`, `browser_type` and `browser_type_secure` with `submit` wait for a navigation they trigger and return `navigated`, `url` and `title`. Pass `waitForNavigation: false` to skip (no navigation costs ~0.4 s of waiting).
- `browser_open` / `browser_navigate` with `recordNetwork: true` attach the debugger **before** loading, so `devtools_network_*` includes the page's own initial requests. Off by default because Chrome then shows its "started debugging this browser" bar.
- `devtools_network_summary` collapses id-like path segments (numbers, UUIDs, long tokens) to `:id`, and returns 15 hosts / 15 paths by default.
- `browser_screenshot` fails immediately with `TAB_NOT_VISIBLE` when the tab is in the background (Chrome can only capture the front tab).

### 5. Secure input (passwords, OTPs, API keys)

Never paste a secret into chat or pass it as `browser_type.text`. Call `browser_type_secure` on the field instead:

```jsonc
{ "ref": "e12", "label": "LinkedIn password", "kind": "password", "submit": true }
```

A small extension window opens **outside the page**, so the page's own scripts cannot read what you type. The value goes from that window through the extension into the Connected tab, then the window closes. The tool returns only `{ filled, chars, submitted }` (+ `navigated`/`url`/`title` when `submit` navigates); the secret is never a tool argument, a tool result, or part of the conversation.

- `kind`: `password` (default), `text`, or `otp`.
- `label`, `targetHint`: shown in the window so you can check what is being asked and where it goes.
- `timeoutMs`: how long to wait for you (default `120000`, max `300000`).
- Cancel, Esc or closing the window returns `SECURE_INPUT_CANCELLED`; a timeout returns `SECURE_INPUT_TIMEOUT`. No value is typed in either case. One secure window per tab at a time (`SECURE_INPUT_BUSY`).

Fields filled this way are marked and redacted (`value=<redacted>`) in later snapshots and find results.

**Caveat:** this keeps the value out of the agent's context, not away from the page. The destination site receives it normally, and its scripts can mirror it into other fields. Check the destination host shown in the window before typing.

### 6. Pin elements (optional)

After Connect, use **Pick element** in the popup (or have the agent call `browser_pick_element`) to enter in-page pick mode. Hover highlights a target; click pins it as `pin_N`. Esc cancels. Pins accumulate until clear, navigation, or Disconnect. Interaction tools accept `pin` instead of a snapshot `ref`. The in-page pin panel has a copy button for `dev-tool-mcp://tab/{tabId}/pin/{id}`.

## Tools (summary)

**Session**: `browser_connect_tab`, `browser_disconnect`, `browser_control_status` (legacy: `browser_request_control`, `browser_release_control`)

**Automation** (no debugger required): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_type_secure`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`, `browser_pick_element`, `browser_pick_cancel`, `browser_pins`, `browser_pin_inspect`, `browser_pin_clear`

**DevTools** (auto-attaches CDP on first use): `devtools_attach` / `devtools_detach`, `devtools_targets`, `devtools_network_requests` (rich filters, WebSocket, `waitForMs` up to 300s), `devtools_network_summary`, `devtools_network_request`, `devtools_network_body`, `devtools_network_for_pin`, `devtools_console_messages`, `devtools_evaluate` (pin-bound `el`, CSP fallback to main/CDP), `devtools_get_box_model`, `devtools_get_computed_style`, `devtools_cookies`, `devtools_storage`, `devtools_cdp` (allowlisted domains including read-mostly `Target.*`)

Attach also binds related existing workers (`chrome.debugger.getTargets` + `attach({ targetId })`) so UPS/presence-style worker traffic can enter the network buffer; new workers use `Target.setAutoAttach`.

## Development

```bash
pnpm --filter @dev-tool-mcp/server dev          # MCP + WS bridge
pnpm --filter @dev-tool-mcp/extension watch     # rebuild extension/dist
```

Reload the unpacked extension in Chrome after rebuilds.

## Trust model

- Localhost WebSocket + HTTP handshake only (token fetched **per port**)
- Page-affecting commands rejected until you Connect a tab in the popup
- Each session acts only on its own Connected tab; taking over a tab another session owns asks you to Allow
- Secrets typed through `browser_type_secure` stay in the extension window and the page; they never enter the agent's context
- No cloud relay of browser traffic

## Manual test checklist

- [ ] MCP server starts; `/health` and `/handshake` respond on 127.0.0.1
- [ ] With Chrome closed, `browser_open` launches Chrome, the extension connects, and the page opens
- [ ] Extension popup shows bridge Connected
- [ ] Connect on a normal https tab; badge shows ON
- [ ] `browser_open` with an https URL creates a tab, Connects it, and badge shows ON (no popup Connect needed)
- [ ] `browser_navigate` with no Connected tab also opens and Connects
- [ ] `browser_open` / `browser_navigate` to `chrome://` fails with RESTRICTED_URL
- [ ] Connect fails on `chrome://` with a clear error
- [ ] `browser_snapshot` then `browser_click` / `browser_type` work
- [ ] `browser_type_secure` opens a separate extension window, types the value, and returns only `{ filled, chars, submitted }`
- [ ] Cancel / Esc / closing the secure window returns `SECURE_INPUT_CANCELLED` and types nothing; timeout returns `SECURE_INPUT_TIMEOUT`; a second prompt on the same tab returns `SECURE_INPUT_BUSY`
- [ ] A text field filled through `browser_type_secure` shows `value=<redacted>` in later snapshots and find results
- [ ] Popup **Pick element** or `browser_pick_element` pins a node; `browser_pins` lists it; `browser_pin_inspect` returns attrs/relatedUrls
- [ ] Esc during pick returns `PICK_CANCELLED`; idle pick times out (~90s)
- [ ] `browser_click({ pin })` works without a fresh snapshot
- [ ] Navigate / Disconnect clears pins
- [ ] Closing Connected tab auto-disconnects
- [ ] Connected tab joins the orange agent tab group, shows the border + pill, and only that tab has the ON badge
- [ ] Border pulses during agent commands, then settles; overlay survives reload/navigation
- [ ] Pill **Stop** disconnects; group, border and badge are removed
- [ ] Screenshots do not include the overlay; screenshot of a background Connected tab never captures a different tab
- [ ] Switching the Connected tab clears network/console buffers from the previous tab
- [ ] Snapshot shows `value=`, `[checked]`, `[disabled]`, `[expanded]` states
- [ ] `devtools_attach` works; fails with guidance if DevTools UI is open on that tab
- [ ] `devtools_attach` returns `workersAttached` when the page has workers; `devtools_targets` lists them with `attached: true`
- [ ] `devtools_network_requests` / `devtools_console_messages` populate after attach (including worker `targetType` when applicable)
- [ ] `devtools_network_summary` returns hosts / topPaths without dumping full entries
- [ ] `devtools_network_for_pin` matches an `<img>` pin; `waitForMs` catches a later request
- [ ] `waitForMs` above 120s (e.g. 130000) with no match returns `{ timedOut: true }` (not bridge TIMEOUT)
- [ ] Isolated `devtools_evaluate` on a CSP-locked page falls back to main/CDP with a note
- [ ] Disconnect / `devtools_detach` detaches debugger (tab + workers) and clears agent target
- [ ] Two MCP instances both show as connected in the popup Bridges list, each with its own tab
- [ ] Two sessions `browser_open` different URLs and work in parallel with no notification; each tab has its own coloured group and label
- [ ] One session's network/console results never include the other session's tab
- [ ] `browser_connect_tab` on a tab owned by another session shows Allow/Deny; Deny keeps the original owner
- [ ] `browser_connect_tab` with no answer for 60 s returns `CONTROL_REQUEST_TIMEOUT` (Deny returns `CONTROL_DENIED`); a late Allow does nothing; clicking the notification body does not count as Allow
- [ ] Popup **Connect** assigns the active tab to the **Connect target** session
- [ ] Stopping an MCP server releases its tab after ~60 s
- [ ] `browser_click` on a link/submit returns `navigated: true` with the new URL
- [ ] `browser_open` with `recordNetwork: true` lists the document request and its subresources
- [ ] `devtools_network_summary` groups `/item/123` and `/item/456` as `/item/:id`
- [ ] `DEV_TOOL_MCP_NAME` appears as `name :port` in the popup and notification

## Limitations

- Open DevTools on the Connected tab often blocks `chrome.debugger` attach
- MV3 service workers sleep; the extension reconnects with backoff + alarms
- Worker network capture is best-effort if Chrome omits a target from `getTargets`
- `fullPage` screenshots are best-effort via CDP
- Element pick is top-frame only (no iframe / open shadow-root piercing in v1)
