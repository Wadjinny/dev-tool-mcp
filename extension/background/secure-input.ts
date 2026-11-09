/**
 * Secure input: the user types a secret (password, OTP, API key) into a small
 * extension window. The value goes from that window straight into the Connected
 * tab through the service worker and content script — it is never a tool
 * argument or tool result, so it cannot appear in the agent's conversation or
 * tool log.
 *
 * The window is an extension page (chrome-extension://), not an in-page
 * overlay, so the page's own scripts cannot read what is being typed.
 */

import {
  ErrorCodes,
  SECURE_INPUT_TIMEOUT_MS,
  bridgeError,
} from "@dev-tool-mcp/shared";

export type SecureInputKind = "password" | "text" | "otp";

export type SecureInputOptions = {
  tabId: number;
  /** Short title, e.g. "LinkedIn password". */
  label: string;
  /** Host of the Connected tab, shown so the user can verify the destination. */
  site: string;
  /** Accessible name of the target field, when known. */
  target?: string;
  kind: SecureInputKind;
  /** True when Enter/the form is submitted right after typing. */
  submit: boolean;
  timeoutMs?: number;
};

type Pending = {
  requestId: string;
  tabId: number;
  windowId: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  keepAlive: ReturnType<typeof setInterval> | null;
  deliver: (secret: string) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

const pendingById = new Map<string, Pending>();
const requestIdByTab = new Map<number, string>();

const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 340;
/** Generous upper bound; real secrets are far shorter. */
const MAX_SECRET_LEN = 16_384;

const SECURE_PAGE = "secure/secure.html";

function isSecurePageUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL(SECURE_PAGE));
}

async function closeWindow(windowId: number | null): Promise<void> {
  if (windowId == null) return;
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // already closed
  }
}

function cleanup(p: Pending): void {
  if (p.timer) clearTimeout(p.timer);
  if (p.keepAlive) clearInterval(p.keepAlive);
  p.timer = null;
  p.keepAlive = null;
  if (pendingById.get(p.requestId) === p) pendingById.delete(p.requestId);
  if (requestIdByTab.get(p.tabId) === p.requestId) {
    requestIdByTab.delete(p.tabId);
  }
}

function buildWindowUrl(
  requestId: string,
  opts: SecureInputOptions,
): string {
  const url = new URL(chrome.runtime.getURL(SECURE_PAGE));
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("label", opts.label);
  url.searchParams.set("site", opts.site);
  if (opts.target) url.searchParams.set("target", opts.target);
  url.searchParams.set("kind", opts.kind);
  if (opts.submit) url.searchParams.set("submit", "1");
  return url.toString();
}

/**
 * Open the secure window and wait for the user to submit. `deliver` receives
 * the secret exactly once and must type it into the page; its result is the
 * tool result. The secret is not retained anywhere after this returns.
 */
export function withSecureInput<T>(
  opts: SecureInputOptions,
  deliver: (secret: string) => Promise<T>,
): Promise<T> {
  if (requestIdByTab.has(opts.tabId)) {
    return Promise.reject(
      bridgeError(
        ErrorCodes.SECURE_INPUT_BUSY,
        "A secure input window is already open for this tab. Submit or cancel it first.",
      ),
    );
  }

  const requestId = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? SECURE_INPUT_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const p: Pending = {
      requestId,
      tabId: opts.tabId,
      windowId: null,
      timer: null,
      keepAlive: null,
      deliver,
      resolve: resolve as (value: unknown) => void,
      reject,
    };

    p.timer = setTimeout(() => {
      cleanup(p);
      void closeWindow(p.windowId);
      reject(
        bridgeError(
          ErrorCodes.SECURE_INPUT_TIMEOUT,
          "Timed out waiting for the user to submit the secure input value.",
        ),
      );
    }, timeoutMs);

    // A pending prompt holds the SW alive while the window is open. The WS
    // connection normally does this too; this covers a quiet bridge.
    p.keepAlive = setInterval(() => {
      void chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);

    pendingById.set(requestId, p);
    requestIdByTab.set(opts.tabId, requestId);

    void (async () => {
      try {
        const parent = await chrome.windows
          .getLastFocused()
          .catch(() => undefined);
        const left =
          parent && typeof parent.left === "number"
            ? Math.round(parent.left + ((parent.width ?? 1200) - WINDOW_WIDTH) / 2)
            : undefined;
        const top =
          parent && typeof parent.top === "number"
            ? Math.round(parent.top + ((parent.height ?? 800) - WINDOW_HEIGHT) / 2)
            : undefined;
        const win = await chrome.windows.create({
          url: buildWindowUrl(requestId, opts),
          type: "popup",
          width: WINDOW_WIDTH,
          height: WINDOW_HEIGHT,
          focused: true,
          ...(left != null ? { left } : {}),
          ...(top != null ? { top } : {}),
        });
        // If the prompt was cancelled while the window was being created.
        if (!pendingById.has(requestId)) {
          await closeWindow(win?.id ?? null);
          return;
        }
        if (win?.id == null) {
          cleanup(p);
          reject(
            bridgeError(
              ErrorCodes.SECURE_INPUT_FAILED,
              "Chrome did not open the secure input window.",
            ),
          );
          return;
        }
        p.windowId = win.id;
      } catch (err) {
        cleanup(p);
        reject(
          bridgeError(
            ErrorCodes.SECURE_INPUT_FAILED,
            `Could not open the secure input window: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    })();
  });
}

/** Cancel a prompt when its tab goes away / navigates. */
export function cancelSecureInputForTab(
  tabId: number,
  reason?: string,
): void {
  const requestId = requestIdByTab.get(tabId);
  const p = requestId ? pendingById.get(requestId) : undefined;
  if (!p) return;
  cleanup(p);
  void closeWindow(p.windowId);
  p.reject(
    bridgeError(
      ErrorCodes.SECURE_INPUT_CANCELLED,
      reason ?? "The secure input prompt was cancelled.",
    ),
  );
}

export type SecureInputMessageResult = {
  handled: boolean;
  ok?: boolean;
  error?: string;
};

/**
 * Handle `secure.submit` / `secure.cancel` messages from the secure window.
 * Returns `{ handled: false }` for anything else so the caller can continue.
 */
export async function handleSecureInputMessage(
  msg: Record<string, unknown>,
): Promise<SecureInputMessageResult> {
  if (msg.type !== "secure.submit" && msg.type !== "secure.cancel") {
    return { handled: false };
  }
  const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
  const p = requestId ? pendingById.get(requestId) : undefined;
  if (!p) {
    return {
      handled: true,
      ok: false,
      error:
        "This secure prompt has expired. Ask the agent to open it again.",
    };
  }

  if (msg.type === "secure.cancel") {
    cleanup(p);
    await closeWindow(p.windowId);
    p.reject(
      bridgeError(ErrorCodes.SECURE_INPUT_CANCELLED, "The user cancelled."),
    );
    return { handled: true, ok: true };
  }

  const value = typeof msg.value === "string" ? msg.value : "";
  if (!value) {
    return { handled: true, ok: false, error: "Enter a value first." };
  }
  if (value.length > MAX_SECRET_LEN) {
    return {
      handled: true,
      ok: false,
      error: `Value is too long (max ${MAX_SECRET_LEN} characters).`,
    };
  }

  cleanup(p);
  try {
    const result = await p.deliver(value);
    p.resolve(result);
    // The page closes itself after its response; this is a fallback.
    setTimeout(() => void closeWindow(p.windowId), 2_000);
    return { handled: true, ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    await closeWindow(p.windowId);
    p.reject(err);
    return {
      handled: true,
      ok: false,
      error: e.message ?? String(err),
    };
  }
}

// Closing the window (Esc, titlebar ×) counts as cancelling.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const p of pendingById.values()) {
    if (p.windowId !== windowId) continue;
    cleanup(p);
    p.reject(
      bridgeError(ErrorCodes.SECURE_INPUT_CANCELLED, "The window was closed."),
    );
    return;
  }
});

// A restarted service worker has no pending state: close leftover prompts so
// a stale window cannot be mistaken for a live one.
void (async () => {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    await Promise.all(
      wins
        .filter((w) =>
          (w.tabs ?? []).some((t) => isSecurePageUrl(t.url)),
        )
        .map((w) => closeWindow(w.id ?? null)),
    );
  } catch {
    // window APIs unavailable
  }
})();
