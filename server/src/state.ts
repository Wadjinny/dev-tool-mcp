import {
  emptyBridgeState,
  type BridgeState,
} from "@dev-tool-mcp/shared";

let state: BridgeState = emptyBridgeState();

export function getBridgeState(): BridgeState {
  return { ...state };
}

export function setBridgeState( partial: Partial<BridgeState>): BridgeState {
  state = { ...state, ...partial };
  return getBridgeState();
}

export function markExtensionConnected(connected: boolean): BridgeState {
  if (!connected) {
    return setBridgeState({
      extensionConnected: false,
      debuggerAttached: false,
    });
  }
  return setBridgeState({ extensionConnected: true });
}

export function applyExtensionState(
  payload: Partial<BridgeState>,
): BridgeState {
  return setBridgeState({
    extensionConnected: true,
    connectedTabId: payload.connectedTabId ?? null,
    connectedTabUrl: payload.connectedTabUrl ?? null,
    connectedTabTitle: payload.connectedTabTitle ?? null,
    debuggerAttached: payload.debuggerAttached ?? false,
  });
}
