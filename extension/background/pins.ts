import {
  ErrorCodes,
  PICK_ELEMENT_TIMEOUT_MS,
  bridgeError,
  type PinDescriptor,
} from "@dev-tool-mcp/shared";

export type PickPayload = {
  pinId: string;
  url: string;
  tag: string;
  role: string;
  name: string;
  selector: string | null;
  box: { x: number; y: number; width: number; height: number };
};

type PickWaiter = {
  resolve: (pin: PinDescriptor) => void;
  reject: (err: ReturnType<typeof bridgeError>) => void;
  timer: ReturnType<typeof setTimeout>;
  pinId: string;
  tabId: number;
};

type ActivePick = {
  pinId: string;
  tabId: number;
  waiter: PickWaiter | null;
};

/** Pins and pick state are per Connected tab (each MCP session owns its own tab). */
type TabPins = {
  pins: PinDescriptor[];
  nextPinNum: number;
  activePick: ActivePick | null;
};

const byTab = new Map<number, TabPins>();

function stateFor(tabId: number): TabPins {
  let st = byTab.get(tabId);
  if (!st) {
    st = { pins: [], nextPinNum: 1, activePick: null };
    byTab.set(tabId, st);
  }
  return st;
}

export function listPins(tabId: number): PinDescriptor[] {
  return [...(byTab.get(tabId)?.pins ?? [])];
}

export function pinCount(tabId: number): number {
  return byTab.get(tabId)?.pins.length ?? 0;
}

export function getPin(tabId: number, id: string): PinDescriptor | undefined {
  return byTab.get(tabId)?.pins.find((p) => p.id === id);
}

export function clearPins(tabId: number, id?: string): { cleared: number } {
  const st = stateFor(tabId);
  if (id) {
    const before = st.pins.length;
    st.pins = st.pins.filter((p) => p.id !== id);
    return { cleared: before - st.pins.length };
  }
  const cleared = st.pins.length;
  st.pins = [];
  st.nextPinNum = 1;
  return { cleared };
}

export function allocatePinId(tabId: number): string {
  const st = stateFor(tabId);
  const id = `pin_${st.nextPinNum}`;
  st.nextPinNum += 1;
  return id;
}

export function isActivePick(tabId: number, pinId: string): boolean {
  return byTab.get(tabId)?.activePick?.pinId === pinId;
}

export function beginPickSession(opts: {
  tabId: number;
  pinId: string;
  timeoutMs?: number;
  wait: boolean;
}): Promise<PinDescriptor | null> {
  const st = stateFor(opts.tabId);
  if (st.activePick?.waiter) {
    throw bridgeError(
      ErrorCodes.PICK_IN_PROGRESS,
      "An element pick is already in progress.",
    );
  }
  // Replace a non-blocking (popup) session if still open.
  if (st.activePick && !st.activePick.waiter) {
    st.activePick = null;
  }

  if (!opts.wait) {
    st.activePick = { pinId: opts.pinId, tabId: opts.tabId, waiter: null };
    return Promise.resolve(null);
  }

  const timeoutMs = opts.timeoutMs ?? PICK_ELEMENT_TIMEOUT_MS;
  return new Promise<PinDescriptor>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (st.activePick?.pinId === opts.pinId) {
        st.activePick = null;
      }
      reject(
        bridgeError(
          ErrorCodes.PICK_TIMEOUT,
          "Element pick timed out before a selection was made.",
        ),
      );
    }, timeoutMs);

    st.activePick = {
      pinId: opts.pinId,
      tabId: opts.tabId,
      waiter: { resolve, reject, timer, pinId: opts.pinId, tabId: opts.tabId },
    };
  });
}

export function completePick(
  tabId: number,
  payload: PickPayload,
): PinDescriptor | null {
  const st = byTab.get(tabId);
  const session = st?.activePick;
  if (!st || !session || session.pinId !== payload.pinId) {
    return null;
  }
  st.activePick = null;

  const pin: PinDescriptor = {
    id: payload.pinId,
    tabId,
    url: payload.url,
    tag: payload.tag,
    role: payload.role,
    name: payload.name,
    selector: payload.selector,
    box: payload.box,
    createdAt: Date.now(),
  };
  st.pins.push(pin);

  if (session.waiter) {
    clearTimeout(session.waiter.timer);
    session.waiter.resolve(pin);
  }
  return pin;
}

/** After a keep-mode pick, arm the next pin id without a blocking waiter. */
export function armNextKeepPick(tabId: number): string {
  const pinId = allocatePinId(tabId);
  stateFor(tabId).activePick = { pinId, tabId, waiter: null };
  return pinId;
}

export function cancelPick(
  tabId: number,
  code: "PICK_CANCELLED" | "PICK_TIMEOUT" = "PICK_CANCELLED",
): boolean {
  const st = byTab.get(tabId);
  const session = st?.activePick;
  if (!st || !session) return false;
  st.activePick = null;
  if (session.waiter) {
    clearTimeout(session.waiter.timer);
    session.waiter.reject(
      bridgeError(
        code === "PICK_TIMEOUT"
          ? ErrorCodes.PICK_TIMEOUT
          : ErrorCodes.PICK_CANCELLED,
        code === "PICK_TIMEOUT"
          ? "Element pick timed out before a selection was made."
          : "Element pick was cancelled.",
      ),
    );
  }
  return true;
}

/** Navigation / disconnect: cancel any pick and drop the tab's pins. */
export function resetPinsForTab(tabId: number): void {
  cancelPick(tabId, "PICK_CANCELLED");
  byTab.delete(tabId);
}
