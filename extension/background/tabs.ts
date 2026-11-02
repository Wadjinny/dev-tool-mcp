import {
  ErrorCodes,
  bridgeError,
  type BridgeState,
  type TabInfo,
} from "@dev-tool-mcp/shared";

export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("view-source:")
  ) {
    return true;
  }
  try {
    const u = new URL(url);
    if (
      u.hostname === "chrome.google.com" &&
      u.pathname.startsWith("/webstore")
    ) {
      return true;
    }
    if (u.hostname === "chromewebstore.google.com") {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Tab ownership: every MCP session (bridge port) owns at most one Connected
 * tab. Sessions act only on their own tab, so several agents can work in
 * parallel without fighting over a global lease.
 */
export type TabOwner = {
  port: number;
  /** Bridge process start time; guards against a new instance reusing the port. */
  startedAt: number | null;
};

const OWNERS_KEY = "tabOwners";
const LEGACY_KEY = "connectedTabId";

let ownersPromise: Promise<Map<number, TabOwner>> | null = null;

type OwnerListener = (
  tabId: number,
  prev: TabOwner | null,
  next: TabOwner | null,
) => Promise<void>;
let ownerListener: OwnerListener = async () => {};

export function onTabOwnerChanged(fn: OwnerListener): void {
  ownerListener = fn;
}

function owners(): Promise<Map<number, TabOwner>> {
  ownersPromise ??= (async () => {
    const data = await chrome.storage.local.get([OWNERS_KEY, LEGACY_KEY]);
    const raw = (data[OWNERS_KEY] ?? {}) as Record<string, TabOwner>;
    const map = new Map<number, TabOwner>();
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.port === "number") map.set(Number(k), v);
    }
    // Pre-multi-tab single connection had no owner; drop it.
    if (data[LEGACY_KEY] != null) await chrome.storage.local.remove(LEGACY_KEY);
    return map;
  })();
  return ownersPromise;
}

async function persist(map: Map<number, TabOwner>): Promise<void> {
  await chrome.storage.local.set({
    [OWNERS_KEY]: Object.fromEntries(
      [...map].map(([id, o]) => [String(id), o]),
    ),
  });
}

export function sameOwner(a: TabOwner | null, b: TabOwner | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.port === b.port &&
    (a.startedAt == null || b.startedAt == null || a.startedAt === b.startedAt)
  );
}

export async function getTabOwner(tabId: number): Promise<TabOwner | null> {
  return (await owners()).get(tabId) ?? null;
}

export async function listOwnedTabs(): Promise<Array<[number, TabOwner]>> {
  return [...(await owners())];
}

/** The tab owned by this session, if any. */
export async function tabIdForOwner(owner: TabOwner): Promise<number | null> {
  for (const [tabId, o] of await owners()) {
    if (sameOwner(o, owner)) return tabId;
  }
  return null;
}

/**
 * Single choke point for connect / disconnect / auto-disconnect. Giving a tab
 * to a session releases that session's previous tab (one tab per session).
 */
export async function setTabOwner(
  tabId: number,
  next: TabOwner | null,
): Promise<void> {
  const map = await owners();
  const prev = map.get(tabId) ?? null;
  const released: Array<[number, TabOwner]> = [];
  if (next) {
    for (const [id, o] of map) {
      if (id !== tabId && o.port === next.port) released.push([id, o]);
    }
    for (const [id] of released) map.delete(id);
    map.set(tabId, next);
  } else {
    map.delete(tabId);
  }
  await persist(map);
  for (const [id, old] of released) await ownerListener(id, old, null);
  if (prev?.port !== next?.port || prev?.startedAt !== next?.startedAt) {
    await ownerListener(tabId, prev, next);
  }
}

/** Release every tab owned by a port (bridge went away for good). */
export async function releaseTabsOfPort(port: number): Promise<number[]> {
  const ids = [...(await owners())]
    .filter(([, o]) => o.port === port)
    .map(([id]) => id);
  for (const id of ids) await setTabOwner(id, null);
  return ids;
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export async function requireTabFor(owner: TabOwner): Promise<chrome.tabs.Tab> {
  const id = await tabIdForOwner(owner);
  if (id == null) {
    throw bridgeError(
      ErrorCodes.NO_CONNECTED_TAB,
      "This session has no Connected tab. Call browser_open with a URL, browser_connect_tab with a tabId from browser_tabs, or click Connect in the extension popup.",
    );
  }
  const tab = await getTab(id);
  if (!tab) {
    await setTabOwner(id, null);
    throw bridgeError(ErrorCodes.TAB_GONE, "The Connected tab was closed.");
  }
  if (isRestrictedUrl(tab.url)) {
    await setTabOwner(id, null);
    throw bridgeError(
      ErrorCodes.RESTRICTED_URL,
      "Connected tab navigated to a restricted URL.",
    );
  }
  return tab;
}

export async function assertConnectable(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await getTab(tabId);
  if (!tab) {
    throw bridgeError(ErrorCodes.TAB_GONE, "Tab not found.");
  }
  if (isRestrictedUrl(tab.url)) {
    throw bridgeError(
      ErrorCodes.RESTRICTED_URL,
      "This URL cannot be Connected (chrome://, extension pages, Web Store, etc.).",
    );
  }
  return tab;
}

export async function buildState(
  extensionConnected: boolean,
  tabId: number | null,
): Promise<BridgeState> {
  const empty: BridgeState = {
    extensionConnected,
    connectedTabId: null,
    connectedTabUrl: null,
    connectedTabTitle: null,
    debuggerAttached: false,
  };
  if (tabId == null) return empty;
  const tab = await getTab(tabId);
  if (!tab) return empty;
  return {
    extensionConnected,
    connectedTabId: tab.id ?? null,
    connectedTabUrl: tab.url ?? null,
    connectedTabTitle: tab.title ?? null,
    debuggerAttached: false, // filled by debugger module
  };
}

export async function listTabs(
  owner: TabOwner,
  includeOthers: boolean,
  labelFor: (port: number) => string,
): Promise<{
  connected: TabInfo | null;
  others?: TabInfo[];
}> {
  const ownId = await tabIdForOwner(owner);
  let connected: TabInfo | null = null;
  if (ownId != null) {
    const tab = await getTab(ownId);
    if (tab?.id != null) connected = toTabInfo(tab);
  }
  if (!includeOthers) {
    return { connected };
  }
  const map = await owners();
  const all = await chrome.tabs.query({});
  const others = all
    .filter((t) => t.id != null && t.id !== ownId)
    .map((t) => {
      const o = map.get(t.id!);
      return {
        ...toTabInfo(t),
        ...(o ? { connectedBy: labelFor(o.port) } : {}),
      };
    });
  return { connected, others };
}

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id!,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: !!tab.active,
    windowId: tab.windowId,
  };
}

/**
 * Detects whether an action (e.g. a click) starts a top-frame navigation and
 * waits for it to finish. Start watching *before* the action.
 */
export function watchNavigation(tabId: number): {
  settle: (opts?: {
    graceMs?: number;
    timeoutMs?: number;
  }) => Promise<{ navigated: boolean; sameDocument?: boolean; timedOut?: boolean }>;
  dispose: () => void;
} {
  let started = false;
  let sameDocument = false;
  let completed = false;
  let wake: (() => void) | null = null;
  const poke = () => wake?.();

  const onBefore = (d: { tabId: number; frameId: number }) => {
    if (d.tabId !== tabId || d.frameId !== 0) return;
    started = true;
    completed = false;
    poke();
  };
  const onDone = (d: { tabId: number; frameId: number }) => {
    if (d.tabId !== tabId || d.frameId !== 0) return;
    if (started) completed = true;
    poke();
  };
  const onSameDoc = (d: { tabId: number; frameId: number }) => {
    if (d.tabId !== tabId || d.frameId !== 0) return;
    if (!started) {
      started = true;
      sameDocument = true;
      completed = true;
    }
    poke();
  };

  chrome.webNavigation.onBeforeNavigate.addListener(onBefore);
  chrome.webNavigation.onCompleted.addListener(onDone);
  chrome.webNavigation.onErrorOccurred.addListener(onDone);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDoc);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDoc);

  const dispose = () => {
    chrome.webNavigation.onBeforeNavigate.removeListener(onBefore);
    chrome.webNavigation.onCompleted.removeListener(onDone);
    chrome.webNavigation.onErrorOccurred.removeListener(onDone);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDoc);
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDoc);
  };

  const waitUntil = (cond: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (cond()) return resolve(true);
      const t = setTimeout(() => {
        wake = null;
        resolve(cond());
      }, ms);
      wake = () => {
        if (cond()) {
          clearTimeout(t);
          wake = null;
          resolve(true);
        }
      };
    });

  const settle = async (opts: { graceMs?: number; timeoutMs?: number } = {}) => {
    try {
      const began = await waitUntil(() => started, opts.graceMs ?? 400);
      if (!began) return { navigated: false };
      const done = await waitUntil(() => completed, opts.timeoutMs ?? 30_000);
      return {
        navigated: true,
        ...(sameDocument ? { sameDocument: true } : {}),
        ...(done ? {} : { timedOut: true }),
      };
    } finally {
      dispose();
    }
  };

  return { settle, dispose };
}

export async function waitForLoad(
  tabId: number,
  load: "complete" | "domcontentloaded" = "complete",
  timeoutMs = 30_000,
): Promise<void> {
  const tab = await getTab(tabId);
  if (!tab) throw bridgeError(ErrorCodes.TAB_GONE, "Tab gone.");
  if (load === "complete" && tab.status === "complete") return;
  if (load === "domcontentloaded" && tab.status !== "loading") return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(bridgeError(ErrorCodes.TIMEOUT, "Load wait timed out."));
    }, timeoutMs);

    const onUpdated = (
      updatedId: number,
      info: { status?: string },
    ) => {
      if (updatedId !== tabId) return;
      if (load === "complete" && info.status === "complete") {
        cleanup();
        resolve();
      }
      if (
        load === "domcontentloaded" &&
        (info.status === "complete" || info.status === "loading")
      ) {
        // status "loading" means navigation started; wait for complete for safety
        if (info.status === "complete") {
          cleanup();
          resolve();
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
