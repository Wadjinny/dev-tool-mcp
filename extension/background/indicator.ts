/**
 * Visual "this tab is agent-controlled" indicator, modelled on Claude in Chrome.
 * Each MCP session (bridge port) gets its own colour:
 *  - its Connected tab is moved into a tab group "🤖 name :port"
 *  - a glowing border + bottom pill ("<agent> is controlling this tab", Stop)
 *    is drawn inside the page; the glow pulses while a command is running
 *  - the toolbar badge shows ON (in the session colour) only on that tab
 */

import { sessionColor } from "@dev-tool-mcp/shared";

type GroupColor = `${chrome.tabGroups.Color}`;
const SESSION_GROUPS_KEY = "indicatorGroupsByPort";
const IDLE_AFTER_MS = 1500;

type OverlayMode = "show" | "busy" | "idle" | "remove" | "hide-temp" | "unhide";

type Indicated = {
  port: number;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

let labelProvider: (port: number) => string | null = () => null;
const indicated = new Map<number, Indicated>();

export function setIndicatorLabelProvider(
  fn: (port: number) => string | null,
): void {
  labelProvider = fn;
}

function agentLabel(port: number): string {
  return labelProvider(port) ?? `dev-tool-mcp :${port}`;
}

/** Stable colour per port (ports live in a small discovery band). */
export function colorFor(port: number): { group: GroupColor; hex: string } {
  const c = sessionColor(port);
  return { group: c.name, hex: c.hex };
}

/** Show (port) or remove (null) the indicator on a tab. */
export async function setTabIndicator(
  tabId: number,
  port: number | null,
): Promise<void> {
  const prev = indicated.get(tabId);
  if (prev?.idleTimer) clearTimeout(prev.idleTimer);
  if (port == null) {
    indicated.delete(tabId);
    await clearIndicator(tabId);
    return;
  }
  indicated.set(tabId, { port, busy: false, idleTimer: null });
  if (prev && prev.port !== port) await runOverlay(tabId, "remove", port);
  await applyIndicator(tabId, port);
}

/** Re-apply after navigation / reload (overlay lives in the document). */
export async function refreshIndicator(tabId: number): Promise<void> {
  const st = indicated.get(tabId);
  if (!st) return;
  await setBadge(tabId, st.port);
  await runOverlay(tabId, st.busy ? "busy" : "show", st.port);
}

/** Re-label everything (bridge identities discovered / changed). */
export async function relabelAll(): Promise<void> {
  for (const [tabId, st] of indicated) {
    await runOverlay(tabId, "remove", st.port);
    await applyIndicator(tabId, st.port);
  }
}

/** Mark agent activity on a tab (pulses the glow). */
export function markActivity(tabId: number): void {
  const st = indicated.get(tabId);
  if (!st) return;
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => {
    st.idleTimer = null;
    st.busy = false;
    if (indicated.get(tabId) === st) void runOverlay(tabId, "idle", st.port);
  }, IDLE_AFTER_MS);
  if (!st.busy) {
    st.busy = true;
    void runOverlay(tabId, "busy", st.port);
  }
}

/** Hide the in-page overlay while fn runs (e.g. so screenshots stay clean). */
export async function withOverlayHidden<T>(
  tabId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const st = indicated.get(tabId);
  if (!st) return fn();
  await runOverlay(tabId, "hide-temp", st.port);
  try {
    return await fn();
  } finally {
    await runOverlay(tabId, "unhide", st.port);
  }
}

async function applyIndicator(tabId: number, port: number): Promise<void> {
  await setBadge(tabId, port);
  await groupTab(tabId, port);
  await runOverlay(tabId, "show", port);
}

async function clearIndicator(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ text: "", tabId }).catch(() => undefined);
  await ungroupTab(tabId);
  await runOverlay(tabId, "remove", 0);
}

async function setBadge(tabId: number, port: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: "ON", tabId });
    await chrome.action.setBadgeBackgroundColor({
      color: colorFor(port).hex,
      tabId,
    });
  } catch {
    // tab may be gone
  }
}

async function getGroups(): Promise<Record<string, number>> {
  const data = await chrome.storage.session.get(SESSION_GROUPS_KEY);
  return (data[SESSION_GROUPS_KEY] ?? {}) as Record<string, number>;
}

function isOurGroup(groups: Record<string, number>, groupId: number): boolean {
  return Object.values(groups).includes(groupId);
}

async function groupTab(tabId: number, port: number): Promise<void> {
  if (!chrome.tabGroups) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await getGroups();
    const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;
    // Never steal a tab out of a group the user made themselves.
    if (tab.groupId !== NONE && !isOurGroup(groups, tab.groupId)) return;

    let groupId: number | null = null;
    const own = groups[String(port)];
    if (own != null) {
      try {
        const g = await chrome.tabGroups.get(own);
        if (g.windowId === tab.windowId) groupId = own;
      } catch {
        // group was closed / ungrouped
      }
    }
    if (groupId == null || tab.groupId !== groupId) {
      groupId =
        groupId != null
          ? await chrome.tabs.group({ tabIds: tabId, groupId })
          : await chrome.tabs.group({
              tabIds: tabId,
              createProperties: { windowId: tab.windowId },
            });
    }
    await chrome.tabGroups.update(groupId, {
      title: `🤖 ${agentLabel(port)}`,
      color: colorFor(port).group,
    });
    await chrome.storage.session.set({
      [SESSION_GROUPS_KEY]: { ...groups, [String(port)]: groupId },
    });
  } catch {
    // grouping is cosmetic; ignore (e.g. tab is being dragged)
  }
}

async function ungroupTab(tabId: number): Promise<void> {
  if (!chrome.tabGroups) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isOurGroup(await getGroups(), tab.groupId)) {
      await chrome.tabs.ungroup(tabId);
    }
  } catch {
    // tab gone
  }
}

async function runOverlay(
  tabId: number,
  mode: OverlayMode,
  port: number,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: overlayInPage,
      args: [mode, agentLabel(port), colorFor(port).hex],
    });
  } catch {
    // restricted page / not yet committed; refreshIndicator retries on load
  }
}

/**
 * Runs inside the page (isolated world). Must be self-contained.
 * The host lives on <html>, outside <body>, in a closed shadow root, so
 * snapshot / find never see it; only the pill accepts pointer events.
 */
function overlayInPage(
  mode: string,
  label: string,
  color: string,
): void | Promise<void> {
  const ID = "__dev_tool_mcp_indicator__";
  let host = document.getElementById(ID) as
    | (HTMLElement & { __root?: ShadowRoot })
    | null;

  if (mode === "remove") {
    host?.remove();
    return;
  }
  if (!host) {
    if (mode === "hide-temp" || mode === "unhide" || mode === "idle") return;
    host = document.createElement("div") as HTMLElement & {
      __root?: ShadowRoot;
    };
    host.id = ID;
    host.style.cssText =
      "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    host.__root = root;
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .frame {
          position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 2px ${color}, inset 0 0 18px 2px ${color}66;
          transition: box-shadow .3s ease;
        }
        .frame.busy { animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse {
          0%,100% { box-shadow: inset 0 0 0 2px ${color}, inset 0 0 18px 2px ${color}66; }
          50%     { box-shadow: inset 0 0 0 3px ${color}, inset 0 0 36px 8px ${color}99; }
        }
        .pill {
          position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 6px 6px 6px 12px; border-radius: 999px;
          background: #1f1f1f; color: #fff; pointer-events: auto;
          font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
          box-shadow: 0 4px 16px rgba(0,0,0,.35); border: 1px solid ${color};
          user-select: none; max-width: 90vw;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: ${color}; flex: none; }
        .busy-dot { animation: blink 1s ease-in-out infinite; }
        @keyframes blink { 50% { opacity: .25; } }
        .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button {
          all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
          font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .stop { background: ${color}; color: #1f1f1f; }
        .stop:hover { filter: brightness(1.1); }
        .min { color: #bbb; padding: 4px 8px; }
        .min:hover { color: #fff; }
        .pill.collapsed .text, .pill.collapsed .stop { display: none; }
        .pill.collapsed { padding: 6px; gap: 4px; }
      </style>
      <div class="frame"></div>
      <div class="pill" role="status">
        <span class="dot"></span>
        <span class="text"></span>
        <button class="stop" title="Disconnect this tab from the agent">Stop</button>
        <button class="min" title="Collapse">–</button>
      </div>`;
    const pill = root.querySelector(".pill") as HTMLElement;
    root.querySelector(".stop")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void chrome.runtime.sendMessage({ target: "sw", type: "disconnect" });
    });
    root.querySelector(".min")!.addEventListener("click", (e) => {
      e.stopPropagation();
      pill.classList.toggle("collapsed");
      (e.currentTarget as HTMLElement).textContent = pill.classList.contains(
        "collapsed",
      )
        ? "+"
        : "–";
    });
    document.documentElement.appendChild(host);
  }

  const root = host.__root;
  if (!root) return;
  const frame = root.querySelector(".frame") as HTMLElement;
  const dot = root.querySelector(".dot") as HTMLElement;
  (root.querySelector(".text") as HTMLElement).textContent =
    `${label} is controlling this tab`;

  if (mode === "hide-temp") {
    host.style.visibility = "hidden";
    // Let the hide reach the compositor before a capture (rAF never fires in
    // background tabs, hence the timeout).
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 100);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(t);
          resolve();
        }),
      );
    });
  }
  if (mode === "unhide") {
    host.style.visibility = "";
    return;
  }
  const isBusy = mode === "busy";
  frame.classList.toggle("busy", isBusy);
  dot.classList.toggle("busy-dot", isBusy);
}
