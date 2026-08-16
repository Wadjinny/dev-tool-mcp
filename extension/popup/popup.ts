import { instanceLabel } from "@dev-tool-mcp/shared";

type PopupState = {
  bridgeStatus: "connected" | "disconnected" | "reconnecting";
  lastError: string | null;
  port: number;
  pinCount?: number;
  pendingLabel?: string | null;
  state: {
    connectedTabId: number | null;
    connectedTabUrl: string | null;
    connectedTabTitle: string | null;
    debuggerAttached: boolean;
  };
  activeTab: {
    id?: number;
    title?: string;
    url?: string;
    restricted?: boolean;
  } | null;
};

type Bridge = {
  port: number;
  pid: number;
  cwd: string;
  startedAt: number;
  preferredPort: number;
  name: string | null;
  extensionConnected: boolean;
  controlling: boolean;
};

const els = {
  bridges: document.getElementById("bridges")!,
  pendingControl: document.getElementById("pending-control")!,
  btnRefreshBridges: document.getElementById(
    "btn-refresh-bridges",
  ) as HTMLButtonElement,
  bridgeDot: document.getElementById("bridge-dot")!,
  bridgeStatus: document.getElementById("bridge-status")!,
  activeTitle: document.getElementById("active-title")!,
  activeUrl: document.getElementById("active-url")!,
  btnConnect: document.getElementById("btn-connect") as HTMLButtonElement,
  btnDisconnect: document.getElementById("btn-disconnect") as HTMLButtonElement,
  btnPick: document.getElementById("btn-pick") as HTMLButtonElement,
  target: document.getElementById("target")!,
  pinCount: document.getElementById("pin-count")!,
  errorPanel: document.getElementById("error-panel")!,
  lastError: document.getElementById("last-error")!,
  port: document.getElementById("port") as HTMLInputElement,
  btnApplyPort: document.getElementById("btn-apply-port") as HTMLButtonElement,
  btnReconnect: document.getElementById("btn-reconnect") as HTMLButtonElement,
};

function send<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: "sw", ...msg }) as Promise<T>;
}

function originOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function render(data: PopupState): void {
  const status = data.bridgeStatus;
  els.bridgeStatus.textContent =
    status === "connected"
      ? "Connected"
      : status === "reconnecting"
        ? "Reconnecting…"
        : "Disconnected";
  els.bridgeDot.className =
    "dot " +
    (status === "connected" ? "on" : status === "reconnecting" ? "warn" : "off");

  const active = data.activeTab;
  els.activeTitle.textContent = active?.title || "(untitled)";
  els.activeUrl.textContent = active?.url || "(no url)";

  const connectedId = data.state.connectedTabId;
  const isThisConnected =
    connectedId != null && active?.id != null && connectedId === active.id;

  els.btnConnect.hidden = isThisConnected;
  els.btnDisconnect.hidden = !isThisConnected;
  els.btnPick.hidden = !isThisConnected;
  els.btnConnect.disabled = !!active?.restricted || !active?.id;
  els.btnPick.disabled = !isThisConnected;
  if (active?.restricted) {
    els.btnConnect.title = "This URL cannot be Connected";
  } else {
    els.btnConnect.title = "";
  }

  if (connectedId != null) {
    const title = data.state.connectedTabTitle || "Tab";
    const origin = originOf(data.state.connectedTabUrl);
    els.target.textContent = `Connected: ${title} · ${origin}${
      data.state.debuggerAttached ? " · debugger" : ""
    }`;
  } else {
    els.target.textContent = "No tab connected";
  }

  els.pinCount.textContent = `Pins: ${data.pinCount ?? 0}`;

  if (data.lastError) {
    els.errorPanel.hidden = false;
    els.lastError.textContent = data.lastError;
  } else {
    els.errorPanel.hidden = true;
    els.lastError.textContent = "";
  }

  els.port.value = String(data.port);
  setPendingLabel(data.pendingLabel ?? null);
}

/** Last path segment, so a long cwd still identifies the project. */
function projectOf(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function setPendingLabel(label: string | null): void {
  if (!label) {
    els.pendingControl.hidden = true;
    els.pendingControl.textContent = "";
    return;
  }
  els.pendingControl.hidden = false;
  els.pendingControl.textContent = `Pending control request from ${label}`;
}

function renderBridges(bridges: Bridge[], pendingLabel?: string | null): void {
  els.bridges.textContent = "";
  setPendingLabel(pendingLabel ?? null);

  if (bridges.length === 0) {
    els.bridges.textContent = "No local MCP server found.";
    return;
  }

  for (const bridge of bridges) {
    const row = document.createElement("div");
    row.className =
      "bridge" +
      (bridge.controlling ? " controlling" : "") +
      (bridge.extensionConnected ? " connected" : "");

    const info = document.createElement("div");
    info.className = "bridge-info";

    const port = document.createElement("div");
    port.className = "bridge-port";
    port.textContent = instanceLabel(bridge);

    const meta = document.createElement("div");
    meta.className = "bridge-meta";
    meta.textContent = `pid ${bridge.pid} · ${projectOf(bridge.cwd)}`;
    meta.title = bridge.cwd;

    info.append(port, meta);
    row.append(info);

    if (bridge.controlling) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = bridge.extensionConnected
        ? "controlling"
        : "selected";
      row.append(badge);
    } else {
      if (bridge.extensionConnected) {
        const badge = document.createElement("span");
        badge.className = "badge connected";
        badge.textContent = "connected";
        row.append(badge);
      }
      const btn = document.createElement("button");
      btn.className = "btn tiny";
      btn.type = "button";
      btn.textContent = "Control";
      btn.addEventListener("click", () => {
        void (async () => {
          btn.disabled = true;
          const res = await send<{ ok: boolean; error?: string }>({
            type: "controlPort",
            port: bridge.port,
          });
          if (!res.ok && res.error) {
            els.errorPanel.hidden = false;
            els.lastError.textContent = res.error;
          }
          await refreshBridges();
          await refresh();
        })();
      });
      row.append(btn);
    }

    els.bridges.append(row);
  }
}

let scanning = false;

/**
 * A scan probes a whole port band, so let the interval poll skip while one is
 * already in flight. An explicit Refresh always runs.
 */
async function refreshBridges(force = false): Promise<void> {
  if (scanning && !force) return;
  scanning = true;
  try {
    const res = await send<{
      ok: boolean;
      bridges?: Bridge[];
      pendingLabel?: string | null;
    }>({
      type: "listBridges",
    });
    if (res.ok && res.bridges) renderBridges(res.bridges, res.pendingLabel);
  } finally {
    scanning = false;
  }
}

async function refresh(): Promise<void> {
  const res = await send<{ ok: boolean } & PopupState>({
    type: "getPopupState",
  });
  if (res.ok) render(res);
}

els.btnConnect.addEventListener("click", () => {
  void (async () => {
    const res = await send<{ ok: boolean; error?: string }>({
      type: "connectActive",
    });
    if (!res.ok && res.error) {
      els.errorPanel.hidden = false;
      els.lastError.textContent = res.error;
    }
    await refresh();
  })();
});

els.btnDisconnect.addEventListener("click", () => {
  void (async () => {
    await send({ type: "disconnect" });
    await refresh();
  })();
});

els.btnPick.addEventListener("click", () => {
  void (async () => {
    const res = await send<{ ok: boolean; error?: string }>({
      type: "startPicker",
    });
    if (!res.ok && res.error) {
      els.errorPanel.hidden = false;
      els.lastError.textContent = res.error;
      return;
    }
    // Popup may close; picker continues in the Connected tab.
    window.close();
  })();
});

els.btnApplyPort.addEventListener("click", () => {
  void (async () => {
    const port = Number(els.port.value);
    await send({ type: "setPort", port });
    await refreshBridges();
    await refresh();
  })();
});

els.btnRefreshBridges.addEventListener("click", () => {
  void (async () => {
    els.btnRefreshBridges.disabled = true;
    els.btnRefreshBridges.textContent = "Scanning…";
    try {
      await refreshBridges(true);
    } finally {
      els.btnRefreshBridges.disabled = false;
      els.btnRefreshBridges.textContent = "Refresh";
    }
  })();
});

els.btnReconnect.addEventListener("click", () => {
  void (async () => {
    await send({ type: "reconnect" });
    setTimeout(() => void refresh(), 300);
  })();
});

void refresh();
setInterval(() => void refresh(), 1500);

// Discovery scans a whole port band, so poll it far less often than tab state.
void refreshBridges();
setInterval(() => void refreshBridges(), 5000);
