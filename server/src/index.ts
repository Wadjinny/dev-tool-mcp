#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import {
  clearPortFile,
  getTokenFilePath,
  loadOrCreateToken,
  writePortFile,
} from "./token.js";
import { setBridge, WsBridge } from "./ws-bridge.js";

/** How often to retry binding when the whole discovery band was busy. */
const RETRY_BIND_MS = 15_000;
/** Hard ceiling on graceful shutdown before we exit regardless. */
const SHUTDOWN_GRACE_MS = 3_000;

async function main(): Promise<void> {
  const token = await loadOrCreateToken();
  const bridge = new WsBridge(token);
  setBridge(bridge);

  let retryTimer: NodeJS.Timeout | null = null;
  let retrying = false;
  let startFailureLogged = false;

  const announceListening = async (): Promise<void> => {
    await writePortFile(bridge.port);
    console.error(
      `[dev-tool-mcp] Handshake token file: ${getTokenFilePath()}`,
    );
    console.error(
      `[dev-tool-mcp] Extension handshake: http://127.0.0.1:${bridge.port}/handshake`,
    );
  };

  const startBridge = async (): Promise<boolean> => {
    try {
      await bridge.start();
      if (startFailureLogged) {
        console.error(
          `[dev-tool-mcp] Bridge recovered on port ${bridge.port} after earlier port contention.`,
        );
        startFailureLogged = false;
      }
      await announceListening();
      return true;
    } catch (err) {
      if (!startFailureLogged) {
        startFailureLogged = true;
        // A bridge that cannot bind must not stop the MCP server from
        // starting: that would make the client drop every tool.
        console.error(
          "[dev-tool-mcp] Bridge failed to start; serving MCP without browser connectivity:",
          err instanceof Error ? err.message : err,
        );
        console.error(
          `[dev-tool-mcp] Retrying every ${RETRY_BIND_MS / 1_000}s in case a discovery port frees up.`,
        );
      }
      return false;
    }
  };

  if (!(await startBridge())) {
    retryTimer = setInterval(() => {
      if (retrying || bridge.isListening()) return;
      retrying = true;
      void startBridge().finally(() => {
        retrying = false;
      });
    }, RETRY_BIND_MS);
    // stdin (the MCP transport) keeps the process alive; this timer must not.
    retryTimer.unref();
  }

  const mcp = createMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  let shuttingDown = false;
  /**
   * Exit when the client goes away. Without this, a bridge whose MCP client
   * died keeps running (reparented to init) and holds its discovery port
   * forever, eventually exhausting the 20-port band for every new session.
   */
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    console.error(`[dev-tool-mcp] Shutting down (${reason}).`);

    // Never let a wedged socket keep the process (and its port) alive.
    const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      if (bridge.isListening()) {
        await clearPortFile(bridge.port);
      }
      await bridge.stop();
    } catch (err) {
      console.error("[dev-tool-mcp] Shutdown error:", err);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // The MCP client owns stdin. EOF means it is gone (normal exit, crash, or a
  // respawn that abandoned this child), so stop instead of lingering.
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("disconnect", () => void shutdown("parent disconnected"));
}

main().catch((err) => {
  console.error("[dev-tool-mcp] Fatal:", err);
  process.exit(1);
});
