# dev-tool-mcp

Chrome Manifest V3 extension + TypeScript MCP server that lets an AI agent automate and inspect your **real Chrome profile**, gated by an explicit per-tab **Connect** control. Hybrid page automation (content scripts) plus DevTools depth via `chrome.debugger` (CDP).

See [SPEC.md](./SPEC.md) for architecture, protocol, and tool catalog.

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

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`
4. Chrome will warn about the `debugger` permission. Access is limited to the tab you Connect and a local MCP server.

### 4. Connect a tab

Either:

- Open the site in Chrome, click the **dev-tool-mcp** icon, then **Connect**, or
- Ask the agent to `browser_open` / `browser_navigate` a URL (creates a tab and Connects it)

Restricted URLs (`chrome://`, extension pages, Web Store) cannot be opened or Connected.

Only one Connected tab at a time. Disconnect clears the gate and detaches the debugger.

Several Cursor sessions can stay attached at once. **Read-only** tools work from every instance. **Mutating** tools need the control lease: auto-granted if free, otherwise a Chrome notification (Allow / Deny). The popup **Control** button grants instantly. Agents can also call `browser_request_control` / `browser_release_control`.

### 5. Pin elements (optional)

After Connect, use **Pick element** in the popup (or have the agent call `browser_pick_element`) to enter in-page pick mode. Hover highlights a target; click pins it as `pin_N`. Esc cancels. Pins accumulate until clear, navigation, or Disconnect. Interaction tools accept `pin` instead of a snapshot `ref`. The in-page pin panel has a copy button for `dev-tool-mcp://tab/{tabId}/pin/{id}`.

## Tools (summary)

**Control**: `browser_request_control`, `browser_release_control`, `browser_control_status`

**Automation** (no debugger required): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`, `browser_pick_element`, `browser_pick_cancel`, `browser_pins`, `browser_pin_inspect`, `browser_pin_clear`

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
- Mutating commands also require the control lease (notification or popup Control)
- No cloud relay of browser traffic

## Manual test checklist

- [ ] MCP server starts; `/health` and `/handshake` respond on 127.0.0.1
- [ ] Extension popup shows bridge Connected
- [ ] Connect on a normal https tab; badge shows ON
- [ ] `browser_open` with an https URL creates a tab, Connects it, and badge shows ON (no popup Connect needed)
- [ ] `browser_navigate` with no Connected tab also opens and Connects
- [ ] `browser_open` / `browser_navigate` to `chrome://` fails with RESTRICTED_URL
- [ ] Connect fails on `chrome://` with a clear error
- [ ] `browser_snapshot` then `browser_click` / `browser_type` work
- [ ] Popup **Pick element** or `browser_pick_element` pins a node; `browser_pins` lists it; `browser_pin_inspect` returns attrs/relatedUrls
- [ ] Esc during pick returns `PICK_CANCELLED`; idle pick times out (~90s)
- [ ] `browser_click({ pin })` works without a fresh snapshot
- [ ] Navigate / Disconnect clears pins
- [ ] Closing Connected tab auto-disconnects
- [ ] `devtools_attach` works; fails with guidance if DevTools UI is open on that tab
- [ ] `devtools_attach` returns `workersAttached` when the page has workers; `devtools_targets` lists them with `attached: true`
- [ ] `devtools_network_requests` / `devtools_console_messages` populate after attach (including worker `targetType` when applicable)
- [ ] `devtools_network_summary` returns hosts / topPaths without dumping full entries
- [ ] `devtools_network_for_pin` matches an `<img>` pin; `waitForMs` catches a later request
- [ ] `waitForMs` above 120s (e.g. 130000) with no match returns `{ timedOut: true }` (not bridge TIMEOUT)
- [ ] Isolated `devtools_evaluate` on a CSP-locked page falls back to main/CDP with a note
- [ ] Disconnect / `devtools_detach` detaches debugger (tab + workers) and clears agent target
- [ ] Two MCP instances both show as connected in the popup Bridges list
- [ ] A mutating tool from a second instance shows an Allow/Deny notification; Deny leaves the first in control
- [ ] Popup **Control** on another bridge grants instantly without a notification
- [ ] `DEV_TOOL_MCP_NAME` appears as `name :port` in the popup and notification

## Limitations

- Open DevTools on the Connected tab often blocks `chrome.debugger` attach
- MV3 service workers sleep; the extension reconnects with backoff + alarms
- Worker network capture is best-effort if Chrome omits a target from `getTargets`
- `fullPage` screenshots are best-effort via CDP
- Element pick is top-frame only (no iframe / open shadow-root piercing in v1)
