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

let pins: PinDescriptor[] = [];
let nextPinNum = 1;
let activePick: {
  pinId: string;
  tabId: number;
  waiter: PickWaiter | null;
} | null = null;

export function listPins(): PinDescriptor[] {
  return [...pins];
}

export function pinCount(): number {
  return pins.length;
}

export function getPin(id: string): PinDescriptor | undefined {
  return pins.find((p) => p.id === id);
}

export function clearPins(id?: string): { cleared: number } {
  if (id) {
    const before = pins.length;
    pins = pins.filter((p) => p.id !== id);
    return { cleared: before - pins.length };
  }
  const cleared = pins.length;
  pins = [];
  nextPinNum = 1;
  return { cleared };
}

export function allocatePinId(): string {
  const id = `pin_${nextPinNum}`;
  nextPinNum += 1;
  return id;
}

export function isPickActive(): boolean {
  return activePick != null;
}

export function isActivePick(pinId: string): boolean {
  return activePick?.pinId === pinId;
}

export function beginPickSession(opts: {
  tabId: number;
  pinId: string;
  timeoutMs?: number;
  wait: boolean;
}): Promise<PinDescriptor | null> {
  if (activePick?.waiter) {
    throw bridgeError(
      ErrorCodes.PICK_IN_PROGRESS,
      "An element pick is already in progress.",
    );
  }
  // Replace a non-blocking (popup) session if still open.
  if (activePick && !activePick.waiter) {
    activePick = null;
  }

  if (!opts.wait) {
    activePick = { pinId: opts.pinId, tabId: opts.tabId, waiter: null };
    return Promise.resolve(null);
  }

  const timeoutMs = opts.timeoutMs ?? PICK_ELEMENT_TIMEOUT_MS;
  return new Promise<PinDescriptor>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (activePick?.pinId === opts.pinId) {
        activePick = null;
      }
      reject(
        bridgeError(
          ErrorCodes.PICK_TIMEOUT,
          "Element pick timed out before a selection was made.",
        ),
      );
    }, timeoutMs);

    activePick = {
      pinId: opts.pinId,
      tabId: opts.tabId,
      waiter: { resolve, reject, timer, pinId: opts.pinId, tabId: opts.tabId },
    };
  });
}

export function completePick(payload: PickPayload): PinDescriptor | null {
  if (!activePick || activePick.pinId !== payload.pinId) {
    return null;
  }
  const session = activePick;
  activePick = null;

  const pin: PinDescriptor = {
    id: payload.pinId,
    tabId: session.tabId,
    url: payload.url,
    tag: payload.tag,
    role: payload.role,
    name: payload.name,
    selector: payload.selector,
    box: payload.box,
    createdAt: Date.now(),
  };
  pins.push(pin);

  if (session.waiter) {
    clearTimeout(session.waiter.timer);
    session.waiter.resolve(pin);
  }
  return pin;
}

/** After a keep-mode pick, arm the next pin id without a blocking waiter. */
export function armNextKeepPick(tabId: number): string {
  const pinId = allocatePinId();
  activePick = { pinId, tabId, waiter: null };
  return pinId;
}

export function cancelPick(
  code: "PICK_CANCELLED" | "PICK_TIMEOUT" = "PICK_CANCELLED",
): boolean {
  if (!activePick) return false;
  const session = activePick;
  activePick = null;
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

export function resetPinsForTabChange(): void {
  cancelPick("PICK_CANCELLED");
  clearPins();
}
