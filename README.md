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
        "DEV_TOOL_MCP_WS_PORT": "17373"
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
        "DEV_TOOL_MCP_WS_PORT": "17373"
      }
    }
  }
}
```

The server listens on `ws://127.0.0.1:17373` only (never `0.0.0.0`). Handshake token is stored at `~/.config/dev-tool-mcp/token` (override with `DEV_TOOL_MCP_TOKEN` / `DEV_TOOL_MCP_TOKEN_FILE`).

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`
4. Chrome will warn about the `debugger` permission. Access is limited to the tab you Connect and a local MCP server.

### 4. Connect a tab

1. Open the target site in Chrome (logged-in session stays yours)
2. Click the **dev-tool-mcp** extension icon
3. Click **Connect** on that tab
4. Ask the agent to automate or inspect it

Only one Connected tab at a time. Disconnect clears the gate and detaches the debugger.

### 5. Pin elements (optional)

After Connect, use **Pick element** in the popup (or have the agent call `browser_pick_element`) to enter in-page pick mode. Hover highlights a target; click pins it as `pin_N`. Esc cancels. Pins accumulate until clear, navigation, or Disconnect. Interaction tools accept `pin` instead of a snapshot `ref`.

## Tools (summary)

**Automation** (no debugger required): `browser_tabs`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`, `browser_pick_element`, `browser_pick_cancel`, `browser_pins`, `browser_pin_inspect`, `browser_pin_clear`

**DevTools** (auto-attaches CDP on first use): `devtools_attach` / `devtools_detach`, `devtools_targets`, `devtools_network_requests` (rich filters, WebSocket, `waitForMs` up to 300s), `devtools_network_summary`, `devtools_network_request`, `devtools_network_body`, `devtools_network_for_pin`, `devtools_console_messages`, `devtools_evaluate` (pin-bound `el`, CSP fallback to main/CDP), `devtools_get_box_model`, `devtools_get_computed_style`, `devtools_cookies`, `devtools_storage`, `devtools_cdp` (allowlisted domains including read-mostly `Target.*`)

Attach also binds related existing workers (`chrome.debugger.getTargets` + `attach({ targetId })`) so UPS/presence-style worker traffic can enter the network buffer; new workers use `Target.setAutoAttach`.

## Development

```bash
pnpm --filter @dev-tool-mcp/server dev          # MCP + WS bridge
pnpm --filter @dev-tool-mcp/extension watch     # rebuild extension/dist
```

Reload the unpacked extension in Chrome after rebuilds.

## Trust model

- Localhost WebSocket + HTTP handshake only
- Page-affecting commands rejected until you Connect a tab in the popup
- Shared handshake token; extension fetches it from `http://127.0.0.1:<port>/handshake`
- No cloud relay of browser traffic

## Manual test checklist

- [ ] MCP server starts; `/health` and `/handshake` respond on 127.0.0.1
- [ ] Extension popup shows bridge Connected
- [ ] Connect on a normal https tab; badge shows ON
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

## Limitations

- Open DevTools on the Connected tab often blocks `chrome.debugger` attach
- MV3 service workers sleep; the extension reconnects with backoff + alarms
- Worker network capture is best-effort if Chrome omits a target from `getTargets`
- `fullPage` screenshots are best-effort via CDP
- Element pick is top-frame only (no iframe / open shadow-root piercing in v1)
