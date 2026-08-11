/**
 * Injected automation helpers. Runs in an isolated world.
 * Speaks via chrome.runtime messages and via returned executeScript results.
 */

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
      const role = el.getAttribute("role") || implicitRole(el) || el.tagName.toLowerCase();
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

function resolveRef(ref: string): Element {
  const el = state().refs.get(ref);
  if (!el || !el.isConnected) {
    throw { code: "INVALID_REF", message: `Invalid or stale ref: ${ref}` };
  }
  return el;
}

function center(el: Element): { x: number; y: number } {
  const r = (el as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function click(
  ref: string,
  button: "left" | "right" | "middle" = "left",
  doubleClick = false,
): { ok: true } {
  const el = resolveRef(ref) as HTMLElement;
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

export function hover(ref: string): { ok: true } {
  const el = resolveRef(ref) as HTMLElement;
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

export function drag(startRef: string, endRef: string): { ok: true } {
  const start = resolveRef(startRef) as HTMLElement;
  const end = resolveRef(endRef) as HTMLElement;
  start.scrollIntoView({ block: "center" });
  const a = center(start);
  const b = center(end);
  const down: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: a.x,
    clientY: a.y,
    buttons: 1,
  };
  start.dispatchEvent(new MouseEvent("mousedown", down));
  end.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: b.x,
      clientY: b.y,
      buttons: 1,
    }),
  );
  end.dispatchEvent(
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
  ref: string,
  text: string,
  submit = false,
  slowly = false,
): Promise<{ ok: true }> {
  const el = resolveRef(ref) as HTMLElement;
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

export function evaluate(expression: string): unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${expression})`);
  return fn();
}

export function getRefSelector(ref: string): string | null {
  const el = state().refs.get(ref);
  if (!el) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  return null;
}

export function elementBox(ref: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const el = resolveRef(ref) as HTMLElement;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
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
          case "click":
            result = click(
              String(params.ref),
              (params.button as "left") || "left",
              !!params.doubleClick,
            );
            break;
          case "hover":
            result = hover(String(params.ref));
            break;
          case "drag":
            result = drag(String(params.startRef), String(params.endRef));
            break;
          case "type":
            result = await typeText(
              String(params.ref),
              String(params.text),
              !!params.submit,
              !!params.slowly,
            );
            break;
          case "pressKey":
            result = pressKey(String(params.key));
            break;
          case "evaluate":
            result = { result: evaluate(String(params.expression)) };
            break;
          case "elementBox":
            result = elementBox(String(params.ref));
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
