/**
 * In-page element picker overlay (isolated world).
 */

import {
  getPickMode,
  setPickMode,
  setPinElement,
  setPicking,
} from "./pin-store.js";

const PANEL_REFRESH_EVENT = "__dev_tool_mcp_refresh_panel";

function refreshPinPanel(): void {
  window.dispatchEvent(new CustomEvent(PANEL_REFRESH_EVENT));
}

const OVERLAY_ROOT_ID = "__dev_tool_mcp_picker_root";
const HIGHLIGHT_ID = "__dev_tool_mcp_picker_hl";
const LABEL_ID = "__dev_tool_mcp_picker_label";
const BANNER_ID = "__dev_tool_mcp_picker_banner";

export type PickPayload = {
  pinId: string;
  url: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  box: { x: number; y: number; width: number; height: number };
};

export {
  clearPinElements,
  getPinElement,
  setPinElement,
} from "./pin-store.js";

type PickerState = {
  active: boolean;
  pinId: string | null;
  prompt: string | null;
  hoverEl: Element | null;
};

const picker: PickerState = {
  active: false,
  pinId: null,
  prompt: null,
  hoverEl: null,
};

export function registerPins(
  pins: Array<{ id: string; selector: string | null }>,
): { ok: true; registered: number } {
  let registered = 0;
  for (const p of pins) {
    if (!p.selector) continue;
    try {
      const el = document.querySelector(p.selector);
      if (el) {
        setPinElement(p.id, el);
        registered += 1;
      }
    } catch {
      // invalid selector
    }
  }
  return { ok: true, registered };
}

function bannerText(): string {
  const mode = getPickMode();
  const modeHint =
    mode === "keep"
      ? "Keep selecting"
      : mode === "one"
        ? "Select one"
        : "Off";
  const base =
    picker.prompt?.trim() ||
    "Click an element to pin it · Esc to cancel";
  return `${base} · ${modeHint}`;
}

function refreshBanner(): void {
  const banner = document.getElementById(BANNER_ID);
  if (banner && picker.active) {
    banner.textContent = bannerText();
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

export function buildSelector(el: Element): string | null {
  if (!(el instanceof Element)) return null;
  if (el.id) {
    const sel = `#${cssEscape(el.id)}`;
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {
      // continue
    }
  }

  const testId =
    el.getAttribute("data-testid") || el.getAttribute("data-test-id");
  if (testId) {
    const sel = `[data-testid="${cssEscape(testId)}"]`;
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {
      // continue
    }
  }

  const aria = el.getAttribute("aria-label");
  if (aria) {
    const sel = `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {
      // continue
    }
  }

  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.documentElement && depth < 6) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === cur!.tagName,
    );
    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
    }
    cur = parent;
    depth += 1;
  }
  const path = parts.join(" > ");
  try {
    if (document.querySelectorAll(path).length === 1) return path;
  } catch {
    return null;
  }
  return path || null;
}

function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button" || t === "reset") return "button";
    if (t === "search") return "searchbox";
    return "textbox";
  }
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "img";
  return el.getAttribute("role") || tag;
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim();
  }
  if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function ensureOverlay(): {
  root: HTMLDivElement;
  highlight: HTMLDivElement;
  label: HTMLDivElement;
  banner: HTMLDivElement;
} {
  let root = document.getElementById(OVERLAY_ROOT_ID) as HTMLDivElement | null;
  if (!root) {
    root = document.createElement("div");
    root.id = OVERLAY_ROOT_ID;
    Object.assign(root.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    const highlight = document.createElement("div");
    highlight.id = HIGHLIGHT_ID;
    Object.assign(highlight.style, {
      position: "fixed",
      border: "2px solid #0e639c",
      background: "rgba(14, 99, 156, 0.15)",
      borderRadius: "2px",
      display: "none",
      boxSizing: "border-box",
      pointerEvents: "none",
    });

    const label = document.createElement("div");
    label.id = LABEL_ID;
    Object.assign(label.style, {
      position: "fixed",
      background: "#0e639c",
      color: "#fff",
      fontSize: "11px",
      lineHeight: "1.3",
      padding: "2px 6px",
      borderRadius: "2px",
      display: "none",
      maxWidth: "360px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      pointerEvents: "none",
      zIndex: "1",
    });

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    Object.assign(banner.style, {
      position: "fixed",
      top: "8px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#1e1e1e",
      color: "#d4d4d4",
      border: "1px solid #3c3c3c",
      fontSize: "12px",
      padding: "6px 12px",
      borderRadius: "4px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
      display: "none",
      pointerEvents: "none",
      zIndex: "2",
    });

    root.append(highlight, label, banner);
    document.documentElement.appendChild(root);
  }

  return {
    root,
    highlight: document.getElementById(HIGHLIGHT_ID) as HTMLDivElement,
    label: document.getElementById(LABEL_ID) as HTMLDivElement,
    banner: document.getElementById(BANNER_ID) as HTMLDivElement,
  };
}

function removeOverlay(): void {
  document.getElementById(OVERLAY_ROOT_ID)?.remove();
}

function isOverlayNode(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  const root = document.getElementById(OVERLAY_ROOT_ID);
  if (root && root.contains(node)) return true;
  // Exclude pin panel + its highlight from pick targeting
  for (const id of [
    "__dev_tool_mcp_pin_panel",
    "__dev_tool_mcp_pin_panel_hl",
    "__dev_tool_mcp_pin_panel_label",
  ]) {
    const el = document.getElementById(id);
    if (el && el.contains(node)) return true;
  }
  return false;
}

function updateHighlight(el: Element | null): void {
  const { highlight, label } = ensureOverlay();
  if (!el || !(el instanceof Element)) {
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

  const role = implicitRole(el);
  const name = accessibleName(el);
  const tag = el.tagName.toLowerCase();
  label.textContent = name
    ? `${tag} · ${role} · "${name}"`
    : `${tag} · ${role}`;
  const labelTop = Math.max(0, r.top - 22);
  Object.assign(label.style, {
    display: "block",
    left: `${Math.max(0, r.left)}px`,
    top: `${labelTop}px`,
  });
}

function onMouseMove(ev: MouseEvent): void {
  if (!picker.active) return;
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!target || isOverlayNode(target)) return;
  picker.hoverEl = target;
  updateHighlight(target);
}

function onClick(ev: MouseEvent): void {
  if (!picker.active || !picker.pinId) return;
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  const target =
    picker.hoverEl ||
    document.elementFromPoint(ev.clientX, ev.clientY);
  if (!(target instanceof Element) || isOverlayNode(target)) return;

  const el = target;
  const keepSelecting = getPickMode() === "keep";

  const r = (el as HTMLElement).getBoundingClientRect();
  const payload: PickPayload = {
    pinId: picker.pinId,
    url: location.href,
    tag: el.tagName.toLowerCase(),
    role: implicitRole(el),
    name: accessibleName(el),
    selector: buildSelector(el),
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
  };

  setPinElement(payload.pinId, el);

  void (async () => {
    const res = (await chrome.runtime.sendMessage({
      target: "sw",
      type: "picker.picked",
      pin: payload,
      keepSelecting,
    })) as { ok?: boolean; nextPinId?: string } | undefined;

    if (keepSelecting && res?.nextPinId && picker.active) {
      picker.pinId = res.nextPinId;
      picker.hoverEl = null;
      refreshBanner();
      return;
    }

    // One-shot (or unexpected keep failure): stop and return to Off.
    setPickMode("off");
    stopPickerInternal(false);
  })();
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!picker.active) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    cancelPicker();
  }
}

function stopPickerInternal(notifyCancel: boolean): void {
  if (!picker.active && !document.getElementById(OVERLAY_ROOT_ID)) {
    picker.pinId = null;
    picker.prompt = null;
    picker.hoverEl = null;
    setPicking(false);
    refreshPinPanel();
    return;
  }
  picker.active = false;
  picker.pinId = null;
  picker.prompt = null;
  picker.hoverEl = null;
  setPicking(false);
  window.removeEventListener("mousemove", onMouseMove, true);
  window.removeEventListener("click", onClick, true);
  window.removeEventListener("keydown", onKeyDown, true);
  removeOverlay();
  refreshPinPanel();
  if (notifyCancel) {
    void chrome.runtime.sendMessage({
      target: "sw",
      type: "picker.cancelled",
    });
  }
}

export function pickerStart(params: {
  pinId: string;
  prompt?: string;
}): { ok: true; active: true } {
  if (picker.active) {
    stopPickerInternal(false);
  }
  // Popup / MCP start defaults to One when currently Off.
  if (getPickMode() === "off") setPickMode("one");
  picker.active = true;
  picker.pinId = params.pinId;
  picker.prompt = params.prompt ?? null;
  picker.hoverEl = null;
  setPicking(true);

  const { banner } = ensureOverlay();
  banner.textContent = bannerText();
  banner.style.display = "block";
  refreshPinPanel();

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  return { ok: true, active: true };
}

export function onPickModeChanged(): void {
  refreshBanner();
}

export function pickerCancel(): { ok: true } {
  cancelPicker();
  return { ok: true };
}

function cancelPicker(): void {
  const wasActive = picker.active;
  setPickMode("off");
  stopPickerInternal(wasActive);
}

export function pickerStatus(): { active: boolean; pinId: string | null } {
  return { active: picker.active, pinId: picker.pinId };
}
