/**
 * Secure input window (extension page). The user types a secret here; it is
 * posted straight to the service worker, which types it into the Connected tab.
 * The value is never displayed again, stored, or returned to the agent.
 */

const params = new URLSearchParams(location.search);
const requestId = params.get("requestId") ?? "";
const kindParam = params.get("kind");
const kind: "password" | "text" | "otp" =
  kindParam === "text" || kindParam === "otp" ? kindParam : "password";
const willSubmit = params.get("submit") === "1";

const titleEl = document.getElementById("title") as HTMLHeadingElement;
const siteEl = document.getElementById("site") as HTMLElement;
const targetEl = document.getElementById("target") as HTMLParagraphElement;
const fieldLabel = document.getElementById("field-label") as HTMLLabelElement;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("secret") as HTMLInputElement;
const reveal = document.getElementById("reveal") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;
const submitBtn = document.getElementById("submit") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const hintEl = document.getElementById("hint") as HTMLParagraphElement;

let done = false;
let busy = false;

function setStatus(text: string, tone: "muted" | "error" | "ok" = "muted") {
  statusEl.textContent = text;
  statusEl.className = `status${tone === "muted" ? "" : ` ${tone}`}`;
}

function setBusy(next: boolean) {
  busy = next;
  input.disabled = next;
  submitBtn.disabled = next;
  cancelBtn.disabled = next;
  reveal.disabled = next;
}

function cancel(): void {
  if (done) return;
  done = true;
  void chrome.runtime
    .sendMessage({ target: "sw", type: "secure.cancel", requestId })
    .catch(() => undefined);
  window.close();
}

function applyKind(): void {
  if (kind === "password") {
    input.type = "password";
    input.autocomplete = "off";
    fieldLabel.textContent = "Password";
    submitBtn.textContent = "Type password";
  } else if (kind === "otp") {
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.setAttribute("pattern", "[0-9]*");
    fieldLabel.textContent = "One-time code";
    submitBtn.textContent = "Type code";
    reveal.hidden = true;
  } else {
    input.type = "text";
    input.autocomplete = "off";
    fieldLabel.textContent = "Secret value";
    submitBtn.textContent = "Type value";
    reveal.hidden = true;
  }
}

async function submit(): Promise<void> {
  if (busy || done) return;
  const value = input.value;
  if (!value) {
    setStatus("Enter a value first.", "error");
    input.focus();
    return;
  }

  busy = true;
  setBusy(true);
  setStatus("Typing into the page…");

  try {
    const response = (await chrome.runtime.sendMessage({
      target: "sw",
      type: "secure.submit",
      requestId,
      value,
    })) as { ok?: boolean; error?: string } | undefined;

    // Drop the value from this document as soon as it has been handed over.
    input.value = "";

    if (response?.ok) {
      done = true;
      setStatus("Typed into the page. Closing…", "ok");
      setTimeout(() => window.close(), 350);
      return;
    }

    busy = false;
    setBusy(false);
    setStatus(
      response?.error ?? "Could not type the value. Check the page and retry.",
      "error",
    );
  } catch (err) {
    input.value = "";
    busy = false;
    setBusy(false);
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Could not reach the extension: ${message}`, "error");
  }
}

if (!requestId) {
  done = true;
  setBusy(true);
  titleEl.textContent = "This prompt has expired";
  setStatus("Ask the agent to open secure input again.", "error");
} else {
  titleEl.textContent = params.get("label") || "Secure input";
  siteEl.textContent = params.get("site") || "the Connected tab";
  const target = params.get("target");
  if (target) {
    targetEl.hidden = false;
    targetEl.textContent = `Field: ${target}`;
  }
  if (willSubmit) {
    hintEl.textContent += " The form will be submitted after typing.";
  }

  applyKind();
  input.focus();

  reveal.addEventListener("click", () => {
    const revealed = input.type === "text" && kind === "password";
    input.type = revealed ? "password" : "text";
    reveal.textContent = revealed ? "Show" : "Hide";
    reveal.setAttribute("aria-pressed", revealed ? "false" : "true");
    input.focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  cancelBtn.addEventListener("click", cancel);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });

  // Closing the window without submitting cancels the pending prompt.
  window.addEventListener("pagehide", () => {
    if (!done) {
      void chrome.runtime
        .sendMessage({ target: "sw", type: "secure.cancel", requestId })
        .catch(() => undefined);
    }
  });
}
