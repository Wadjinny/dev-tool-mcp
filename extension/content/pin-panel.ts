/**
 * Narrow right-edge panel listing pinned elements.
 */

import { pinToUri, type PinDescriptor } from "@dev-tool-mcp/shared";
import {
  clearPinElements,
  getPickMode,
  getPinElement,
  isPicking,
  setPickMode,
  setPinElement,
  type PickMode,
} from "./pin-store.js";
import { onPickModeChanged, pickerCancel } from "./picker.js";

export type PanelPin = PinDescriptor;

const PANEL_ROOT_ID = "__dev_tool_mcp_pin_panel";
const PANEL_HL_ID = "__dev_tool_mcp_pin_panel_hl";
const PANEL_LABEL_ID = "__dev_tool_mcp_pin_panel_label";
const PANEL_REFRESH_EVENT = "__dev_tool_mcp_refresh_panel";

let panelPins: PanelPin[] = [];

if (typeof window !== "undefined" && !(window as unknown as { __devToolMcpPanelListener?: boolean }).__devToolMcpPanelListener) {
  (window as unknown as { __devToolMcpPanelListener?: boolean }).__devToolMcpPanelListener =
    true;
  window.addEventListener(PANEL_REFRESH_EVENT, () => {
    renderPanel();
  });
}

export function isPinPanelNode(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  const root = document.getElementById(PANEL_ROOT_ID);
  const hl = document.getElementById(PANEL_HL_ID);
  const label = document.getElementById(PANEL_LABEL_ID);
  return (
    (!!root && root.contains(node)) ||
    (!!hl && hl.contains(node)) ||
    (!!label && label.contains(node))
  );
}

function resolvePinEl(pin: PanelPin): Element | null {
  const live = getPinElement(pin.id);
  if (live && live.isConnected) return live;
  if (!pin.selector) return null;
  try {
    const el = document.querySelector(pin.selector);
    if (el) {
      setPinElement(pin.id, el);
      return el;
    }
  } catch {
    // invalid selector
  }
  return null;
}

function ensureHighlight(): {
  highlight: HTMLDivElement;
  label: HTMLDivElement;
} {
  let highlight = document.getElementById(PANEL_HL_ID) as HTMLDivElement | null;
  let label = document.getElementById(PANEL_LABEL_ID) as HTMLDivElement | null;
  if (!highlight) {
    highlight = document.createElement("div");
    highlight.id = PANEL_HL_ID;
    Object.assign(highlight.style, {
      all: "initial",
      position: "fixed",
      border: "2px solid #0e639c",
      background: "rgba(14, 99, 156, 0.18)",
      borderRadius: "2px",
      display: "none",
      boxSizing: "border-box",
      pointerEvents: "none",
      zIndex: "2147483645",
    });
    document.documentElement.appendChild(highlight);
  }
  if (!label) {
    label = document.createElement("div");
    label.id = PANEL_LABEL_ID;
    Object.assign(label.style, {
      all: "initial",
      position: "fixed",
      background: "#0e639c",
      color: "#fff",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "11px",
      lineHeight: "1.3",
      padding: "2px 6px",
      borderRadius: "2px",
      display: "none",
      maxWidth: "280px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      pointerEvents: "none",
      zIndex: "2147483645",
    });
    document.documentElement.appendChild(label);
  }
  return { highlight, label };
}

function showHighlight(el: Element | null, pin?: PanelPin): void {
  const { highlight, label } = ensureHighlight();
  if (!el) {
    highlight.style.display = "none";
    label.style.display = "none";
    return;
  }
  const r = (el as HTMLElement).getBoundingClientRect();
  Object.assign(highlight.style, {
    display: "block",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${Math.max(r.width, 1)}px`,
    height: `${Math.max(r.height, 1)}px`,
  });
  const title = pin
    ? pin.name
      ? `${pin.id} · ${pin.tag} · "${pin.name}"`
      : `${pin.id} · ${pin.tag}`
    : "";
  if (title) {
    label.textContent = title;
    Object.assign(label.style, {
      display: "block",
      left: `${Math.max(0, r.left)}px`,
      top: `${Math.max(0, r.top - 22)}px`,
    });
  } else {
    label.style.display = "none";
  }
}

function hideHighlight(): void {
  showHighlight(null);
}

function removePanelDom(): void {
  document.getElementById(PANEL_ROOT_ID)?.remove();
  document.getElementById(PANEL_HL_ID)?.remove();
  document.getElementById(PANEL_LABEL_ID)?.remove();
}

function modeToggleButton(mode: PickMode, label: string, active: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  const activeBg = mode === "off" ? "#3c3c3c" : "#0e639c";
  Object.assign(btn.style, {
    all: "unset",
    flex: "1 1 0",
    textAlign: "center",
    fontSize: "10px",
    fontWeight: "600",
    padding: "5px 2px",
    borderRadius: "3px",
    cursor: "pointer",
    color: active ? "#fff" : "#9d9d9d",
    background: active ? activeBg : "transparent",
  });
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (getPickMode() === mode) return;

    if (mode === "off") {
      setPickMode("off");
      pickerCancel();
      onPickModeChanged();
      renderPanel();
      return;
    }

    setPickMode(mode);
    onPickModeChanged();
    renderPanel();
    if (!isPicking()) {
      void chrome.runtime.sendMessage({
        target: "sw",
        type: "startPicker",
      });
    }
  });
  return btn;
}

function iconButton(ariaLabel: string, glyph: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", ariaLabel);
  btn.title = ariaLabel;
  btn.textContent = glyph;
  Object.assign(btn.style, {
    all: "unset",
    flex: "0 0 auto",
    width: "18px",
    height: "18px",
    lineHeight: "16px",
    textAlign: "center",
    borderRadius: "3px",
    color: "#9d9d9d",
    cursor: "pointer",
    fontSize: glyph === "×" ? "14px" : "11px",
    fontWeight: "700",
  });
  btn.addEventListener("mouseenter", () => {
    btn.style.background = glyph === "×" ? "#3a1d1d" : "#2a2d2e";
    btn.style.color = glyph === "×" ? "#f48771" : "#4ec9b0";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "transparent";
    btn.style.color = "#9d9d9d";
  });
  return btn;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      Object.assign(ta.style, {
        position: "fixed",
        left: "-9999px",
        top: "0",
      });
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function asPanelPin(raw: Partial<PanelPin> & { id: string }): PanelPin {
  const box = raw.box ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    id: raw.id,
    tabId: typeof raw.tabId === "number" ? raw.tabId : 0,
    url: raw.url ?? "",
    tag: raw.tag ?? "",
    role: raw.role ?? "",
    name: raw.name ?? "",
    selector: raw.selector ?? null,
    box: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    },
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
  };
}

function renderPanel(): void {
  if (panelPins.length === 0 && !isPicking()) {
    removePanelDom();
    return;
  }

  let root = document.getElementById(PANEL_ROOT_ID) as HTMLDivElement | null;
  if (!root) {
    root = document.createElement("div");
    root.id = PANEL_ROOT_ID;
    Object.assign(root.style, {
      all: "initial",
      position: "fixed",
      top: "12px",
      right: "8px",
      bottom: "12px",
      width: "196px",
      zIndex: "2147483646",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      padding: "6px",
      boxSizing: "border-box",
      background: "rgba(30, 30, 30, 0.92)",
      border: "1px solid #3c3c3c",
      borderRadius: "6px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: "#d4d4d4",
      pointerEvents: "auto",
      overflow: "hidden",
    });
    document.documentElement.appendChild(root);
  }

  root.replaceChildren();

  const mode = getPickMode();
  const toggle = document.createElement("div");
  Object.assign(toggle.style, {
    display: "flex",
    gap: "2px",
    padding: "2px",
    background: "#1e1e1e",
    border: "1px solid #3c3c3c",
    borderRadius: "4px",
    flex: "0 0 auto",
    marginBottom: "2px",
  });
  toggle.append(
    modeToggleButton("off", "Off", mode === "off"),
    modeToggleButton("one", "One", mode === "one"),
    modeToggleButton("keep", "Keep", mode === "keep"),
  );
  root.appendChild(toggle);

  const header = document.createElement("div");
  Object.assign(header.style, {
    fontSize: "10px",
    fontWeight: "700",
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    color: "#9d9d9d",
    padding: "2px 4px 6px",
    flex: "0 0 auto",
  });
  header.textContent =
    panelPins.length > 0
      ? `Pins (${panelPins.length})`
      : isPicking()
        ? "Pick mode"
        : "Pins";
  root.appendChild(header);

  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    overflowY: "auto",
    flex: "1 1 auto",
    minHeight: "0",
  });

  for (const pin of panelPins) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "5px 6px",
      borderRadius: "4px",
      background: "#252526",
      border: "1px solid #3c3c3c",
      cursor: "default",
      minWidth: "0",
    });

    const meta = document.createElement("div");
    Object.assign(meta.style, {
      flex: "1 1 auto",
      minWidth: "0",
      overflow: "hidden",
    });

    const idLine = document.createElement("div");
    Object.assign(idLine.style, {
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: "10px",
      color: "#4ec9b0",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    idLine.textContent = pin.id;

    const nameLine = document.createElement("div");
    Object.assign(nameLine.style, {
      fontSize: "10px",
      color: "#d4d4d4",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      marginTop: "1px",
    });
    nameLine.textContent = pin.name
      ? `${pin.tag} · ${pin.name}`
      : `${pin.tag}${pin.role ? ` · ${pin.role}` : ""}`;

    meta.append(idLine, nameLine);

    const copyBtn = iconButton(`Copy ${pin.id}`, "⧉");
    copyBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void (async () => {
        const uri = pinToUri(pin);
        const ok = await copyText(uri);
        const prev = copyBtn.textContent;
        copyBtn.textContent = ok ? "✓" : "!";
        copyBtn.style.color = ok ? "#4ec9b0" : "#f48771";
        setTimeout(() => {
          copyBtn.textContent = prev;
          copyBtn.style.color = "#9d9d9d";
        }, 900);
      })();
    });

    const removeBtn = iconButton(`Remove ${pin.id}`, "×");
    removeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideHighlight();
      void chrome.runtime.sendMessage({
        target: "sw",
        type: "pins.remove",
        id: pin.id,
      });
    });

    row.addEventListener("mouseenter", () => {
      row.style.borderColor = "#0e639c";
      row.style.background = "#2a2d2e";
      showHighlight(resolvePinEl(pin), pin);
    });
    row.addEventListener("mouseleave", () => {
      row.style.borderColor = "#3c3c3c";
      row.style.background = "#252526";
      hideHighlight();
    });

    row.append(meta, copyBtn, removeBtn);
    list.appendChild(row);
  }

  root.appendChild(list);
}

export function refreshPinPanel(): void {
  renderPanel();
}

export function syncPinPanel(
  pins: Array<Partial<PanelPin> & { id: string }>,
): { ok: true; count: number } {
  panelPins = Array.isArray(pins) ? pins.map(asPanelPin) : [];
  for (const pin of panelPins) {
    if (pin.selector) {
      try {
        const el = document.querySelector(pin.selector);
        if (el) setPinElement(pin.id, el);
      } catch {
        // ignore
      }
    }
  }
  renderPanel();
  return { ok: true, count: panelPins.length };
}

export function clearPinPanel(id?: string): { ok: true } {
  if (id) {
    panelPins = panelPins.filter((p) => p.id !== id);
    clearPinElements(id);
  } else {
    panelPins = [];
    clearPinElements();
  }
  hideHighlight();
  renderPanel();
  return { ok: true };
}
