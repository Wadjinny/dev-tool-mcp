type PopupState = {
  bridgeStatus: "connected" | "disconnected" | "reconnecting";
  lastError: string | null;
  port: number;
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

const els = {
  bridgeDot: document.getElementById("bridge-dot")!,
  bridgeStatus: document.getElementById("bridge-status")!,
  activeTitle: document.getElementById("active-title")!,
  activeUrl: document.getElementById("active-url")!,
  btnConnect: document.getElementById("btn-connect") as HTMLButtonElement,
  btnDisconnect: document.getElementById("btn-disconnect") as HTMLButtonElement,
  target: document.getElementById("target")!,
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
  els.btnConnect.disabled = !!active?.restricted || !active?.id;
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

  if (data.lastError) {
    els.errorPanel.hidden = false;
    els.lastError.textContent = data.lastError;
  } else {
    els.errorPanel.hidden = true;
    els.lastError.textContent = "";
  }

  els.port.value = String(data.port);
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

els.btnApplyPort.addEventListener("click", () => {
  void (async () => {
    const port = Number(els.port.value);
    await send({ type: "setPort", port });
    await refresh();
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
