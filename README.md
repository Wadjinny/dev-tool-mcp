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

## Tools (summary)

**Automation** (no debugger required): `browser_tabs`, `browser_navigate`, `browser_go_back` / `browser_go_forward`, `browser_wait`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_press_key`, `browser_screenshot`, `browser_console_messages`

**DevTools** (auto-attaches CDP on first use): `devtools_attach` / `devtools_detach`, `devtools_network_requests`, `devtools_network_body`, `devtools_console_messages`, `devtools_evaluate`, `devtools_get_box_model`, `devtools_get_computed_style`, `devtools_cookies`, `devtools_storage`, `devtools_cdp` (allowlisted domains)

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
- [ ] Closing Connected tab auto-disconnects
- [ ] `devtools_attach` works; fails with guidance if DevTools UI is open on that tab
- [ ] `devtools_network_requests` / `devtools_console_messages` populate after attach
- [ ] Disconnect detaches debugger and clears agent target

## Limitations

- Open DevTools on the Connected tab often blocks `chrome.debugger` attach
- MV3 service workers sleep; the extension reconnects with backoff + alarms
- `fullPage` screenshots are best-effort via CDP
