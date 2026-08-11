import {
  ErrorCodes,
  bridgeError,
  type BridgeState,
  type TabInfo,
} from "@dev-tool-mcp/shared";

const STORAGE_KEY = "connectedTabId";

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

export async function getConnectedTabId(): Promise<number | null> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const id = data[STORAGE_KEY];
  return typeof id === "number" ? id : null;
}

export async function setConnectedTabId(tabId: number | null): Promise<void> {
  if (tabId == null) {
    await chrome.storage.local.remove(STORAGE_KEY);
  } else {
    await chrome.storage.local.set({ [STORAGE_KEY]: tabId });
  }
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export async function requireConnectedTab(): Promise<chrome.tabs.Tab> {
  const id = await getConnectedTabId();
  if (id == null) {
    throw bridgeError(
      ErrorCodes.NO_CONNECTED_TAB,
      "No tab Connected in the extension popup.",
    );
  }
  const tab = await getTab(id);
  if (!tab) {
    await setConnectedTabId(null);
    throw bridgeError(ErrorCodes.TAB_GONE, "The Connected tab was closed.");
  }
  if (isRestrictedUrl(tab.url)) {
    await setConnectedTabId(null);
    throw bridgeError(
      ErrorCodes.RESTRICTED_URL,
      "Connected tab navigated to a restricted URL.",
    );
  }
  return tab;
}

export async function connectTab(tabId: number): Promise<BridgeState> {
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
  await setConnectedTabId(tabId);
  await updateBadge(true);
  return buildState(true, true);
}

export async function disconnectTab(): Promise<BridgeState> {
  await setConnectedTabId(null);
  await updateBadge(false);
  return buildState(true, false);
}

export async function buildState(
  extensionConnected: boolean,
  _unused?: boolean,
): Promise<BridgeState> {
  const id = await getConnectedTabId();
  if (id == null) {
    return {
      extensionConnected,
      connectedTabId: null,
      connectedTabUrl: null,
      connectedTabTitle: null,
      debuggerAttached: false,
    };
  }
  const tab = await getTab(id);
  if (!tab) {
    await setConnectedTabId(null);
    await updateBadge(false);
    return {
      extensionConnected,
      connectedTabId: null,
      connectedTabUrl: null,
      connectedTabTitle: null,
      debuggerAttached: false,
    };
  }
  return {
    extensionConnected,
    connectedTabId: tab.id ?? null,
    connectedTabUrl: tab.url ?? null,
    connectedTabTitle: tab.title ?? null,
    debuggerAttached: false, // filled by debugger module
  };
}

export async function updateBadge(on: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: on ? "ON" : "" });
  if (on) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0e639c" });
  }
}

export async function listTabs(includeOthers: boolean): Promise<{
  connected: TabInfo | null;
  others?: TabInfo[];
}> {
  const connectedId = await getConnectedTabId();
  let connected: TabInfo | null = null;
  if (connectedId != null) {
    const tab = await getTab(connectedId);
    if (tab?.id != null) {
      connected = toTabInfo(tab);
    }
  }
  if (!includeOthers) {
    return { connected };
  }
  const all = await chrome.tabs.query({});
  const others = all
    .filter((t) => t.id != null && t.id !== connectedId)
    .map(toTabInfo);
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
