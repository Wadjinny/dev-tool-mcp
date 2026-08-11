/**
 * Injected automation helpers. Runs in an isolated world.
 * Speaks via chrome.runtime messages and via returned executeScript results.
 */

import {
  getPinElement,
  pickerCancel,
  pickerStart,
  pickerStatus,
  registerPins,
  setPinElement,
} from "./picker.js";
import { clearPinPanel, syncPinPanel } from "./pin-panel.js";

type RefMap = Map<string, Element>;

declare global {
  interface Window {
    __devToolMcp?: {
      refs: RefMap;
      nextId: number;
    };
    __devToolMcpListener?: boolean;
  }
}

function state() {
  if (!window.__devToolMcp) {
    window.__devToolMcp = { refs: new Map(), nextId: 1 };
  }
  return window.__devToolMcp;
}

function isInteresting(el: Element): boolean {
  const role = el.getAttribute("role") || implicitRole(el);
  const tag = el.tagName.toLowerCase();
  if (
    ["a", "button", "input", "select", "textarea", "summary", "option"].includes(
      tag,
    )
  ) {
    return true;
  }
  if (
    role &&
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
      "tab",
      "switch",
      "searchbox",
      "slider",
      "option",
      "heading",
    ].includes(role)
  ) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute("tabindex") != null) return true;
  return false;
}

function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const map: Record<string, string> = {
    a: "link",
    button: "button",
    input: inputRole(el as HTMLInputElement),
    select: "combobox",
    textarea: "textbox",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    img: "img",
    summary: "button",
  };
  return map[tag] ?? "";
}

function inputRole(el: HTMLInputElement): string {
  const t = (el.type || "text").toLowerCase();
  if (t === "checkbox") return "checkbox";
  if (t === "radio") return "radio";
  if (t === "range") return "slider";
  if (t === "submit" || t === "button" || t === "reset") return "button";
  if (t === "search") return "searchbox";
  return "textbox";
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "");
    const joined = parts.filter(Boolean).join(" ");
    if (joined) return joined;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim();
    if (el.labels && el.labels[0]) {
      return (el.labels[0].innerText || "").trim().slice(0, 80);
    }
  }
  if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();
  const title = el.getAttribute("title");
  if (title) return title.trim();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function visible(el: Element): boolean {
  const html = el as HTMLElement;
  if (!html.getBoundingClientRect) return false;
  const style = window.getComputedStyle(html);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  const r = html.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export type SnapshotResult = {
  snapshot: string;
  refs: Record<string, { role: string; name: string; tag: string }>;
};

export type TargetParams = {
  ref?: string;
  pin?: string;
  selector?: string | null;
};

export function snapshot(interestingOnly = true): SnapshotResult {
  const st = state();
  st.refs.clear();
  st.nextId = 1;
  const refs: SnapshotResult["refs"] = {};
  const lines: string[] = ["- document:"];

  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_ELEMENT,
  );

  let node = walker.currentNode as Element | null;
  while (node) {
    const el = node;
    if (visible(el) && (!interestingOnly || isInteresting(el))) {
      const role =
        el.getAttribute("role") || implicitRole(el) || el.tagName.toLowerCase();
      const name = accessibleName(el);
      const ref = `e${st.nextId++}`;
      st.refs.set(ref, el);
      refs[ref] = { role, name, tag: el.tagName.toLowerCase() };
      const indent = "  ";
      const namePart = name ? ` "${name.replace(/"/g, '\\"')}"` : "";
      lines.push(`${indent}- ${role}${namePart} [ref=${ref}]`);
    }
    node = walker.nextNode() as Element | null;
  }

  return { snapshot: lines.join("\n"), refs };
}

export type FindMatch = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  text: string;
};

export type FindResult = {
  matches: FindMatch[];
};

/** Search interesting/visible nodes by accessible name, aria, or text. Builds/refreshes refs. */
export function find(query: string, limit = 20): FindResult {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [] };

  // Refresh ref map so returned refs are clickable.
  snapshot(true);

  const st = state();
  const matches: FindMatch[] = [];
  for (const [ref, el] of st.refs) {
    const role =
      el.getAttribute("role") || implicitRole(el) || el.tagName.toLowerCase();
    const name = accessibleName(el);
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const aria = el.getAttribute("aria-label") || "";
    const title = el.getAttribute("title") || "";
    const hay = `${name} ${text} ${aria} ${title} ${role}`.toLowerCase();
    if (!hay.includes(q)) continue;
    matches.push({
      ref,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      text,
    });
    if (matches.length >= limit) break;
  }
  return { matches };
}

function resolveTarget(params: TargetParams): Element {
  const pin = typeof params.pin === "string" ? params.pin : undefined;
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  const selector =
    typeof params.selector === "string" ? params.selector : undefined;

  if (pin) {
    const live = getPinElement(pin);
    if (live && live.isConnected) return live;
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          setPinElement(pin, el);
          return el;
        }
      } catch {
        // invalid selector
      }
    }
    throw {
      code: "INVALID_PIN",
      message: `Invalid or stale pin: ${pin}`,
    };
  }

  if (ref) {
    const el = state().refs.get(ref);
    if (!el || !el.isConnected) {
      throw { code: "INVALID_REF", message: `Invalid or stale ref: ${ref}` };
    }
    return el;
  }

  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      // invalid selector
    }
    throw {
      code: "INVALID_REF",
      message: `Selector not found: ${selector}`,
    };
  }

  throw {
    code: "INVALID_REF",
    message: "Provide exactly one of ref or pin.",
  };
}

function center(el: Element): { x: number; y: number } {
  const r = (el as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function click(
  target: TargetParams,
  button: "left" | "right" | "middle" = "left",
  doubleClick = false,
): { ok: true } {
  const el = resolveTarget(target) as HTMLElement;
  el.scrollIntoView({ block: "center", inline: "center" });
  const { x, y } = center(el);
  const btn = button === "right" ? 2 : button === "middle" ? 1 : 0;
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: btn,
    buttons: btn === 0 ? 1 : btn === 2 ? 2 : 4,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  if (doubleClick) {
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.dispatchEvent(new MouseEvent("dblclick", opts));
  } else {
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  if (typeof el.focus === "function") el.focus();
  return { ok: true };
}

export function hover(target: TargetParams): { ok: true } {
  const el = resolveTarget(target) as HTMLElement;
  el.scrollIntoView({ block: "center", inline: "center" });
  const { x, y } = center(el);
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
  };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  return { ok: true };
}

export function drag(start: TargetParams, end: TargetParams): { ok: true } {
  const startEl = resolveTarget(start) as HTMLElement;
  const endEl = resolveTarget(end) as HTMLElement;
  startEl.scrollIntoView({ block: "center" });
  const a = center(startEl);
  const b = center(endEl);
  const down: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: a.x,
    clientY: a.y,
    buttons: 1,
  };
  startEl.dispatchEvent(new MouseEvent("mousedown", down));
  endEl.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: b.x,
      clientY: b.y,
      buttons: 1,
    }),
  );
  endEl.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: b.x,
      clientY: b.y,
    }),
  );
  return { ok: true };
}

export async function typeText(
  target: TargetParams,
  text: string,
  submit = false,
  slowly = false,
): Promise<{ ok: true }> {
  const el = resolveTarget(target) as HTMLElement;
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.isContentEditable
  ) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (const ch of text) {
      if (slowly) await new Promise((r) => setTimeout(r, 40));
      document.execCommand("insertText", false, ch);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
    }
    if (submit) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
        }),
      );
      if (el instanceof HTMLInputElement && el.form) {
        el.form.requestSubmit?.();
      }
    }
  }
  return { ok: true };
}

export function pressKey(key: string): { ok: true } {
  const target = (document.activeElement as HTMLElement) || document.body;
  const opts: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  return { ok: true };
}

export function evaluate(
  expression: string,
  target?: TargetParams,
): unknown {
  if (target && (target.pin || target.ref || target.selector)) {
    const el = resolveTarget(target);
    // eslint-disable-next-line no-new-func
    const fn = new Function("el", `return (${expression})`);
    return fn(el);
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${expression})`);
  return fn();
}

function extractCssUrls(value: string | null): string[] {
  if (!value || value === "none") return [];
  const out: string[] = [];
  const re = /url\((['"]?)(.*?)\1\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m[2]) out.push(m[2]);
  }
  return out;
}

function absolutize(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

export function inspectElement(target: TargetParams): {
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  attrs: Record<string, string>;
  text: string;
  nearbyText: string;
  outerHTML: string;
  src: string | null;
  currentSrc: string | null;
  href: string | null;
  backgroundImage: string | null;
  ariaLabel: string | null;
  title: string | null;
  box: { x: number; y: number; width: number; height: number };
  matchCount: number;
  relatedUrls: string[];
} {
  const el = resolveTarget(target) as HTMLElement;
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    attrs[a.name] = a.value;
  }

  const htmlEl = el as HTMLElement & {
    src?: string;
    currentSrc?: string;
    href?: string;
  };
  const src = absolutize(
    htmlEl.currentSrc || htmlEl.src || el.getAttribute("src"),
  );
  const currentSrc = absolutize(htmlEl.currentSrc || null);
  const href = absolutize(
    htmlEl.href || el.getAttribute("href") || el.getAttribute("xlink:href"),
  );
  const cs = getComputedStyle(el);
  const backgroundImage =
    cs.backgroundImage && cs.backgroundImage !== "none"
      ? cs.backgroundImage
      : null;

  let nearbyText = "";
  let p: Element | null = el.parentElement;
  for (let i = 0; i < 5 && p; i++) {
    const t = (p.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length < 400) {
      nearbyText = t;
      break;
    }
    p = p.parentElement;
  }

  const related = new Set<string>();
  for (const u of [src, currentSrc, href]) {
    if (u) related.add(u);
  }
  for (const u of extractCssUrls(backgroundImage)) {
    const abs = absolutize(u);
    if (abs) related.add(abs);
  }
  const srcset = el.getAttribute("srcset");
  if (srcset) {
    for (const part of srcset.split(",")) {
      const candidate = part.trim().split(/\s+/)[0];
      const abs = absolutize(candidate);
      if (abs) related.add(abs);
    }
  }

  let matchCount = 0;
  const selector =
    typeof target.selector === "string" ? target.selector : null;
  if (selector) {
    try {
      matchCount = document.querySelectorAll(selector).length;
    } catch {
      matchCount = 0;
    }
  }

  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || implicitRole(el),
    name: accessibleName(el),
    selector,
    attrs,
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
    nearbyText,
    outerHTML: el.outerHTML.slice(0, 1200),
    src,
    currentSrc,
    href,
    backgroundImage,
    ariaLabel: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    matchCount,
    relatedUrls: [...related],
  };
}

export function elementBox(target: TargetParams): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const el = resolveTarget(target) as HTMLElement;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function targetFromParams(params: Record<string, unknown>): TargetParams {
  return {
    ref: typeof params.ref === "string" ? params.ref : undefined,
    pin: typeof params.pin === "string" ? params.pin : undefined,
    selector: typeof params.selector === "string" ? params.selector : undefined,
  };
}

// Message bridge when registered as a content script (once per frame)
if (!window.__devToolMcpListener) {
  window.__devToolMcpListener = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.channel !== "dev-tool-mcp") return false;
    void (async () => {
      try {
        const { action, params } = msg as {
          action: string;
          params: Record<string, unknown>;
        };
        let result: unknown;
        switch (action) {
          case "ping":
            result = { ok: true };
            break;
          case "snapshot":
            result = snapshot(!!params.interestingOnly);
            break;
          case "find":
            result = find(
              String(params.query ?? ""),
              typeof params.limit === "number" ? params.limit : 20,
            );
            break;
          case "click":
            result = click(
              targetFromParams(params),
              (params.button as "left") || "left",
              !!params.doubleClick,
            );
            break;
          case "hover":
            result = hover(targetFromParams(params));
            break;
          case "drag":
            result = drag(
              {
                ref:
                  typeof params.startRef === "string"
                    ? params.startRef
                    : undefined,
                pin:
                  typeof params.startPin === "string"
                    ? params.startPin
                    : undefined,
                selector:
                  typeof params.startSelector === "string"
                    ? params.startSelector
                    : undefined,
              },
              {
                ref:
                  typeof params.endRef === "string" ? params.endRef : undefined,
                pin:
                  typeof params.endPin === "string" ? params.endPin : undefined,
                selector:
                  typeof params.endSelector === "string"
                    ? params.endSelector
                    : undefined,
              },
            );
            break;
          case "type":
            result = await typeText(
              targetFromParams(params),
              String(params.text),
              !!params.submit,
              !!params.slowly,
            );
            break;
          case "pressKey":
            result = pressKey(String(params.key));
            break;
          case "evaluate":
            result = {
              result: evaluate(
                String(params.expression),
                params.pin || params.ref || params.selector
                  ? targetFromParams(params)
                  : undefined,
              ),
            };
            break;
          case "pins.inspect":
            result = inspectElement(targetFromParams(params));
            break;
          case "elementBox":
            result = elementBox(targetFromParams(params));
            break;
          case "pickerStart":
            result = pickerStart({
              pinId: String(params.pinId),
              prompt:
                typeof params.prompt === "string" ? params.prompt : undefined,
            });
            break;
          case "pickerCancel":
            result = pickerCancel();
            break;
          case "pickerStatus":
            result = pickerStatus();
            break;
          case "pins.register":
            result = registerPins(
              (params.pins as Array<{ id: string; selector: string | null }>) ??
                [],
            );
            break;
          case "pins.sync":
            result = syncPinPanel(
              (params.pins as Array<{
                id: string;
                tag: string;
                role: string;
                name: string;
                selector: string | null;
              }>) ?? [],
            );
            break;
          case "pins.clearLocal":
            result = clearPinPanel(
              typeof params.id === "string" ? params.id : undefined,
            );
            break;
          default:
            throw { code: "UNKNOWN", message: `Unknown action ${action}` };
        }
        sendResponse({ ok: true, result });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        sendResponse({
          ok: false,
          error: {
            code: e.code ?? "CONTENT_SCRIPT_FAILED",
            message: e.message ?? String(err),
          },
        });
      }
    })();
    return true;
  });
}
