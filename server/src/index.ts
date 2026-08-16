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

async function main(): Promise<void> {
  const token = await loadOrCreateToken();
  const bridge = new WsBridge(token);
  setBridge(bridge);

  // A bridge that cannot bind must not stop the MCP server from starting:
  // exiting here would make the client drop every tool this server exposes.
  try {
    await bridge.start();
    await writePortFile(bridge.port);
    console.error(
      `[dev-tool-mcp] Handshake token file: ${getTokenFilePath()}`,
    );
    console.error(
      `[dev-tool-mcp] Extension handshake: http://127.0.0.1:${bridge.port}/handshake`,
    );
  } catch (err) {
    console.error(
      "[dev-tool-mcp] Bridge failed to start; serving MCP without browser connectivity:",
      err instanceof Error ? err.message : err,
    );
  }

  const mcp = createMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = async () => {
    if (bridge.isListening()) {
      await clearPortFile(bridge.port);
    }
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[dev-tool-mcp] Fatal:", err);
  process.exit(1);
});
