import { projectOfCwd, sessionColor } from "@dev-tool-mcp/shared";

type PopupState = {
  bridgeStatus: "connected" | "disconnected" | "reconnecting";
  lastError: string | null;
  port: number;
  pinCount?: number;
  pendingLabel?: string | null;
  /** "name :port" of the session that owns the active tab, if any. */
  ownerLabel?: string | null;
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
  tabTitle?: string | null;
  tabUrl?: string | null;
};

type Item = {
  id: string;
  label: string;
  hint?: string;
  kbd?: string;
  key?: string;
  enabled: boolean;
  icon: string;
  swatch?: string;
  title?: string;
};

const els = {
  bridgeDot: document.getElementById("bridge-dot")!,
  bridgeStatus: document.getElementById("bridge-status")!,
  pending: document.getElementById("pending")!,
  ownerStrip: document.getElementById("owner-strip")!,
  ownerDot: document.getElementById("owner-dot")!,
  ownerText: document.getElementById("owner-text")!,
  btnStop: document.getElementById("btn-stop") as HTMLButtonElement,
  agentCount: document.getElementById("agent-count")!,
  agents: document.getElementById("agents")!,
  paletteTitle: document.getElementById("palette-title")!,
  paletteBack: document.getElementById("palette-back") as HTMLButtonElement,
  ctx: document.getElementById("ctx")!,
  commands: document.getElementById("commands")!,
  ftKeys: document.getElementById("ft-keys")!,
  ftCount: document.getElementById("ft-count")!,
  errorPanel: document.getElementById("error-panel")!,
  port: document.getElementById("port") as HTMLInputElement,
  btnApplyPort: document.getElementById("btn-apply-port") as HTMLButtonElement,
  btnReconnect: document.getElementById("btn-reconnect") as HTMLButtonElement,
  btnRefresh: document.getElementById("btn-refresh") as HTMLButtonElement,
};

let popup: PopupState | null = null;
let bridges: Bridge[] | null = null;
let mode: "commands" | "handoff" = "commands";
let selected = "stop";
let handPort: number | null = null;
let scanning = false;
let localError: string | null = null;
let paintedKey = "";
let scrolledId = "";

function send<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: "sw", ...msg }) as Promise<T>;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function markOf(url: string | null | undefined): string {
  const host = hostOf(url);
  return host ? host.charAt(0).toUpperCase() : "•";
}

function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return l > 0.62 ? "#1f1f1f" : "#fff";
}

function displayName(bridge: Bridge): string {
  return bridge.name?.trim() || projectOfCwd(bridge.cwd);
}

function ownerPort(): number | null {
  const label = popup?.ownerLabel;
  if (!label) return null;
  const match = label.match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function liveBridges(): Bridge[] {
  return (bridges ?? []).filter((b) => b.extensionConnected);
}

/** Session the Connect card assigns this tab to. Mirrors the service worker. */
function targetBridge(): Bridge | undefined {
  const live = liveBridges();
  return live.find((b) => b.controlling) ?? (live.length === 1 ? live[0] : undefined);
}

function thisTabConnected(): boolean {
  const activeId = popup?.activeTab?.id;
  const connectedId = popup?.state.connectedTabId;
  return connectedId != null && activeId != null && connectedId === activeId;
}

function canConnect(): boolean {
  const active = popup?.activeTab;
  if (!active?.id || active.restricted) return false;
  if (thisTabConnected()) return false;
  return targetBridge() != null;
}

function handCandidates(): Bridge[] {
  const owner = ownerPort();
  return liveBridges().filter((b) => b.port !== owner);
}

function canHand(): boolean {
  const active = popup?.activeTab;
  if (!active?.id || active.restricted) return false;
  return handCandidates().length > 0;
}

function showError(message: string): void {
  localError = message;
  paint();
}

function clearNode(node: HTMLElement): void {
  node.replaceChildren();
}

function appendItem(item: Item, selectedId: string): void {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "it" + (item.id === selectedId ? " sel" : "");
  row.disabled = !item.enabled;
  row.dataset.cmd = item.id;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", item.id === selectedId ? "true" : "false");
  if (item.title) row.title = item.title;

  const icon = document.createElement("span");
  icon.className = "ic";
  icon.setAttribute("aria-hidden", "true");
  if (item.swatch) {
    icon.style.background = item.swatch;
    icon.style.color = inkOn(item.swatch);
  }
  icon.textContent = item.icon;
  row.append(icon);

  const copy = document.createElement("span");
  copy.className = "it-copy";
  const label = document.createElement("span");
  label.className = "it-label ell";
  label.textContent = item.label;
  copy.append(label);
  if (item.hint) {
    const hint = document.createElement("span");
    hint.className = "it-hint ell";
    hint.textContent = item.hint;
    copy.append(hint);
  }
  row.append(copy);

  if (item.kbd) {
    const kbd = document.createElement("kbd");
    kbd.textContent = item.kbd;
    row.append(kbd);
  }
  els.commands.append(row);
}

function commandItems(): Item[] {
  const connected = thisTabConnected();
  const active = popup?.activeTab;
  const target = targetBridge();
  const debuggerOn = connected && !!popup?.state.debuggerAttached;
  const items: Item[] = [];

  if (!connected) {
    items.push({
      id: "connect",
      label: "Connect this tab",
      hint: target ? `to ${displayName(target)}` : undefined,
      kbd: "C",
      key: "c",
      icon: "＋",
      enabled: canConnect(),
      title: active?.restricted
        ? "This page cannot be connected"
        : target
          ? `Give this tab to ${displayName(target)}`
          : "Click a session card to choose a Connect target first",
    });
  } else {
    items.push({
      id: "stop",
      label: "Stop and disconnect",
      kbd: "Bksp",
      key: "Backspace",
      icon: "⏹",
      enabled: true,
      title: "Release this tab",
    });
    items.push({
      id: "pick",
      label: "Pick element",
      kbd: "P",
      key: "p",
      icon: "🎯",
      enabled: true,
      title: "Pin an element on this tab",
    });
  }

  items.push({
    id: "hand",
    label: connected ? "Hand this tab…" : "Connect to a session…",
    kbd: "H",
    key: "h",
    icon: "⇄",
    enabled: canHand(),
    title: active?.restricted
      ? "This page cannot be connected"
      : "Pick the session that should drive this tab",
  });

  if (connected) {
    items.push({
      id: "detach",
      label: "Detach debugger",
      kbd: "D",
      key: "d",
      icon: "🐞",
      enabled: debuggerOn,
      title: debuggerOn
        ? "Detach DevTools from this tab"
        : "The debugger is not attached",
    });
  }

  items.push({
    id: "refresh",
    label: "Refresh sessions",
    kbd: "R",
    key: "r",
    icon: "↻",
    enabled: !scanning,
    title: "Scan for local MCP servers",
  });

  return items;
}

function handoffItems(): Item[] {
  return handCandidates().map((bridge) => {
    const color = sessionColor(bridge.port);
    const where = bridge.tabTitle?.trim() || "No tab yet";
    return {
      id: `hand:${bridge.port}`,
      label: displayName(bridge),
      hint: `:${bridge.port} · ${where}`,
      icon: displayName(bridge).charAt(0).toUpperCase(),
      swatch: color.hex,
      enabled: true,
      title: `Give this tab to ${displayName(bridge)}`,
    };
  });
}

function activeItems(): Item[] {
  return mode === "handoff" ? handoffItems() : commandItems();
}

function reconcileSelection(items: Item[]): void {
  const enabled = items.filter((item) => item.enabled);
  if (mode === "handoff") {
    const current = `hand:${handPort}`;
    if (!enabled.some((item) => item.id === current)) {
      handPort = enabled[0] ? Number(enabled[0].id.slice(5)) : null;
    }
    if (enabled.length === 0) mode = "commands";
    return;
  }
  if (!enabled.some((item) => item.id === selected)) {
    selected = enabled[0]?.id ?? "refresh";
  }
}

function selectedId(): string {
  return mode === "handoff" ? `hand:${handPort}` : selected;
}

function paintStatus(): void {
  const status = popup?.bridgeStatus ?? "disconnected";
  const quiet = !!popup && status === "connected";
  els.bridgeStatus.hidden = quiet;
  els.bridgeStatus.textContent = quiet
    ? ""
    : !popup
      ? "…"
      : status === "reconnecting"
        ? "Reconnecting…"
        : "Disconnected";
  els.bridgeDot.className =
    "dot " +
    (status === "connected" ? "on" : status === "reconnecting" ? "warn" : "off");
}

function paintPending(): void {
  const label = popup?.pendingLabel;
  if (!label) {
    els.pending.hidden = true;
    els.pending.textContent = "";
    return;
  }
  els.pending.hidden = false;
  els.pending.textContent = `${label} is asking to control a tab. Allow it in the Chrome notification.`;
}

function paintOwner(): void {
  const label = popup?.ownerLabel;
  if (!label) {
    els.ownerStrip.hidden = true;
    return;
  }
  const port = ownerPort();
  const hex = port == null ? "#f9ab00" : sessionColor(port).hex;
  els.ownerStrip.hidden = false;
  els.ownerStrip.style.setProperty("--c", hex);
  els.ownerDot.style.background = hex;
  const name = label.replace(/\s*:\d+\s*$/, "").trim();
  els.ownerText.textContent = `This tab: ${name} is in control`;
  els.ownerText.title = label;
}

function paintAgents(): void {
  clearNode(els.agents);
  if (bridges == null) {
    els.agentCount.textContent = "Scanning…";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Looking for local MCP servers…";
    els.agents.append(empty);
    return;
  }

  const live = liveBridges().length;
  els.agentCount.textContent =
    bridges.length === 0
      ? "None found"
      : live === bridges.length
        ? `${live} connected`
        : `${live} connected · ${bridges.length} found`;

  if (bridges.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No local MCP server found.";
    els.agents.append(empty);
  }

  for (const bridge of bridges) {
    const color = sessionColor(bridge.port);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sc" + (bridge.extensionConnected ? "" : " off");
    card.dataset.port = String(bridge.port);
    card.style.setProperty("--c", color.hex);
    card.title = bridge.controlling
      ? "Connect target"
      : "Make this the Connect target";

    if (bridge.controlling) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Connect target";
      card.append(tag);
    }

    const name = document.createElement("div");
    name.className = "n ell";
    name.textContent = displayName(bridge);
    const meta = document.createElement("div");
    meta.className = "p ell";
    meta.textContent = `:${bridge.port} · pid ${bridge.pid}${
      bridge.extensionConnected ? "" : " · offline"
    }`;
    meta.title = bridge.cwd;

    const tab = document.createElement("div");
    const title = bridge.tabTitle?.trim();
    if (title) {
      tab.className = "tt";
      const fav = document.createElement("span");
      fav.className = "fav";
      fav.style.background = color.hex;
      fav.style.color = inkOn(color.hex);
      fav.textContent = markOf(bridge.tabUrl);
      const label = document.createElement("span");
      label.className = "ell";
      label.textContent = title;
      tab.append(fav, label);
      tab.title = bridge.tabUrl ?? title;
    } else {
      tab.className = "tt idle";
      tab.textContent = "No tab yet";
    }

    card.append(name, meta, tab);
    els.agents.append(card);
  }

  if (!thisTabConnected() && bridges.length > 0) {
    const target = targetBridge();
    const active = popup?.activeTab;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sc add";
    add.dataset.action = "connect";
    add.disabled = !canConnect();
    const main = document.createElement("span");
    main.className = "add-main";
    main.textContent = "+ Connect this tab";
    const sub = document.createElement("span");
    sub.className = "add-sub";
    sub.textContent = active?.restricted
      ? "This page can’t be connected"
      : target
        ? `to ${displayName(target)}`
        : "Choose a session first";
    add.append(main, sub);
    els.agents.append(add);
  }
}

function paintContext(): void {
  clearNode(els.ctx);
  const active = popup?.activeTab;
  const title = active?.title || "(untitled)";
  const host = hostOf(active?.url) || "(no url)";
  const port = ownerPort();
  const hex = port == null ? "#5f6368" : sessionColor(port).hex;

  const fav = document.createElement("span");
  fav.className = "fav";
  fav.style.background = port == null ? "#5f6368" : hex;
  fav.style.color = port == null ? "#fff" : inkOn(hex);
  fav.textContent = markOf(active?.url);

  const copy = document.createElement("div");
  copy.className = "ell";
  const t = document.createElement("div");
  t.className = "t ell";
  t.textContent = title;
  t.title = title;
  const u = document.createElement("div");
  u.className = "u ell";
  const bits = [host];
  if (thisTabConnected()) {
    bits.push(`${popup?.pinCount ?? 0} pins`);
    if (popup?.state.debuggerAttached) bits.push("debugger on");
  }
  u.textContent = bits.join(" · ");
  copy.append(t, u);

  const badge = document.createElement("span");
  if (popup?.ownerLabel && port != null) {
    badge.className = "badge";
    badge.style.setProperty("--c", hex);
    badge.textContent = popup.ownerLabel.replace(/:\d+\s*$/, "").trim();
    badge.title = popup.ownerLabel;
  } else {
    badge.className = "badge idle";
    badge.textContent = active?.restricted ? "Blocked" : "Not connected";
  }

  els.ctx.append(fav, copy, badge);
}

function paintCommands(): void {
  const items = activeItems();
  const handoff = mode === "handoff";
  els.paletteTitle.textContent = handoff ? "Hand this tab to" : "Commands";
  els.paletteBack.hidden = !handoff;
  els.ftKeys.textContent = handoff
    ? "↑↓ · ↵ hand off · Esc back"
    : "↑↓ navigate · ↵ run";

  clearNode(els.commands);
  const current = selectedId();
  for (const item of items) appendItem(item, current);
  if (current !== scrolledId) {
    scrolledId = current;
    els.commands.querySelector(".it.sel")?.scrollIntoView({ block: "nearest" });
  }
}

function paintFooter(): void {
  if (bridges == null) {
    els.ftCount.textContent = "";
    return;
  }
  const n = bridges.length;
  const label = n === 1 ? "1 session" : `${n} sessions`;
  els.ftCount.textContent =
    popup && popup.bridgeStatus !== "connected" ? `· ${label}` : label;
}

function paintError(): void {
  const message = localError || popup?.lastError;
  if (!message) {
    els.errorPanel.hidden = true;
    els.errorPanel.textContent = "";
    return;
  }
  els.errorPanel.hidden = false;
  els.errorPanel.textContent = message;
}

function paintPort(): void {
  if (!popup) return;
  if (document.activeElement !== els.port) {
    els.port.value = String(popup.port);
  }
}

function settleSelection(): void {
  reconcileSelection(activeItems());
  reconcileSelection(activeItems());
}

function paint(): void {
  settleSelection();
  const key = JSON.stringify({
    popup,
    bridges,
    mode,
    selected,
    handPort,
    scanning,
    localError,
  });
  if (key === paintedKey) return;
  paintedKey = key;

  paintStatus();
  paintPending();
  paintOwner();
  paintAgents();
  paintContext();
  paintCommands();
  paintFooter();
  paintError();
  paintPort();
}

async function connectActive(): Promise<void> {
  const res = await send<{ ok: boolean; error?: string }>({
    type: "connectActive",
  });
  if (!res.ok && res.error) showError(res.error);
  await refresh();
  await refreshBridges();
}

async function disconnect(): Promise<void> {
  await send({ type: "disconnect" });
  await refresh();
  await refreshBridges();
}

async function pickElement(): Promise<void> {
  const res = await send<{ ok: boolean; error?: string }>({
    type: "startPicker",
  });
  if (!res.ok && res.error) {
    showError(res.error);
    return;
  }
  window.close();
}

async function detach(): Promise<void> {
  const res = await send<{ ok: boolean; error?: string }>({
    type: "detachDebugger",
  });
  if (!res.ok && res.error) showError(res.error);
  await refresh();
}

async function useForConnect(port: number): Promise<void> {
  const res = await send<{ ok: boolean; error?: string }>({
    type: "controlPort",
    port,
  });
  if (!res.ok && res.error) showError(res.error);
  await refreshBridges();
  await refresh();
}

async function handTo(port: number): Promise<void> {
  mode = "commands";
  const marked = await send<{ ok: boolean; error?: string }>({
    type: "controlPort",
    port,
  });
  if (!marked.ok && marked.error) {
    showError(marked.error);
    await refreshBridges();
    return;
  }
  await connectActive();
}

async function refreshSessions(): Promise<void> {
  els.btnRefresh.disabled = true;
  els.btnRefresh.textContent = "Scanning…";
  try {
    await refreshBridges(true);
    await refresh();
  } finally {
    els.btnRefresh.disabled = false;
    els.btnRefresh.textContent = "Refresh";
  }
}

function openHandoff(): void {
  const first = handCandidates()[0];
  if (!first) return;
  mode = "handoff";
  handPort = first.port;
  paint();
}

async function runCommand(id: string): Promise<void> {
  if (id === "connect") return connectActive();
  if (id === "stop") return disconnect();
  if (id === "pick") return pickElement();
  if (id === "detach") return detach();
  if (id === "refresh") return refreshSessions();
  if (id === "hand") openHandoff();
}

function move(direction: number): void {
  const ids = activeItems()
    .filter((item) => item.enabled)
    .map((item) => item.id);
  if (ids.length === 0) return;
  const current = selectedId();
  let index = ids.indexOf(current);
  if (index < 0) index = direction > 0 ? -1 : 0;
  const next = ids[(index + direction + ids.length) % ids.length]!;
  if (mode === "handoff") handPort = Number(next.slice(5));
  else selected = next;
  paint();
}

function activateSelection(): void {
  if (mode === "handoff") {
    if (handPort != null) void handTo(handPort);
    return;
  }
  const item = commandItems().find((entry) => entry.id === selected);
  if (!item?.enabled) return;
  void runCommand(selected);
}

els.agents.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  const portNode = target.closest<HTMLElement>("[data-port]");
  if (portNode?.dataset.port) {
    mode = "commands";
    const port = Number(portNode.dataset.port);
    const bridge = bridges?.find((entry) => entry.port === port);
    if (bridge && !bridge.controlling) void useForConnect(port);
    paint();
    return;
  }
  if (target.closest("[data-action='connect']")) void connectActive();
});

els.commands.addEventListener("click", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".it");
  const id = row?.dataset.cmd;
  if (!id || row?.hasAttribute("disabled")) return;
  if (mode === "handoff") {
    handPort = Number(id.slice(5));
    void handTo(handPort);
    return;
  }
  selected = id;
  void runCommand(id);
});

els.btnStop.addEventListener("click", () => void disconnect());
els.paletteBack.addEventListener("click", () => {
  mode = "commands";
  paint();
});

document.addEventListener("keydown", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

  if (ev.key === "Escape" && mode === "handoff") {
    ev.preventDefault();
    mode = "commands";
    paint();
    return;
  }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    move(ev.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    activateSelection();
    return;
  }
  if (mode === "handoff" || ev.repeat || ev.shiftKey) return;

  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const hit = commandItems().find((item) => item.enabled && item.key === key);
  if (!hit) return;
  ev.preventDefault();
  selected = hit.id;
  void runCommand(hit.id);
});

els.btnApplyPort.addEventListener("click", () => {
  void (async () => {
    const port = Number(els.port.value);
    const res = await send<{ ok: boolean; error?: string }>({
      type: "setPort",
      port,
    });
    if (!res.ok && res.error) showError(res.error);
    await refreshBridges();
    await refresh();
  })();
});

els.btnReconnect.addEventListener("click", () => {
  void (async () => {
    await send({ type: "reconnect" });
    setTimeout(() => void refresh(), 300);
  })();
});

els.btnRefresh.addEventListener("click", () => void refreshSessions());

async function refresh(): Promise<void> {
  const res = await send<{ ok: boolean } & PopupState>({
    type: "getPopupState",
  });
  if (!res.ok) return;
  popup = res;
  if (res.lastError) localError = null;
  paint();
}

async function refreshBridges(force = false): Promise<void> {
  if (scanning && !force) return;
  scanning = true;
  paint();
  try {
    const res = await send<{
      ok: boolean;
      bridges?: Bridge[];
      pendingLabel?: string | null;
    }>({ type: "listBridges" });
    if (res.ok && res.bridges) {
      bridges = res.bridges;
      if (popup && res.pendingLabel !== undefined) {
        popup.pendingLabel = res.pendingLabel;
      }
    }
  } finally {
    scanning = false;
    paint();
  }
}

void refresh();
setInterval(() => void refresh(), 1500);
void refreshBridges();
setInterval(() => void refreshBridges(), 5000);
