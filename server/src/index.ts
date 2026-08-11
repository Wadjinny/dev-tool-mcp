#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { loadOrCreateToken, getTokenFilePath } from "./token.js";
import { setBridge, WsBridge } from "./ws-bridge.js";

async function main(): Promise<void> {
  const token = await loadOrCreateToken();
  const bridge = new WsBridge(token);
  setBridge(bridge);
  await bridge.start();

  console.error(
    `[dev-tool-mcp] Handshake token file: ${getTokenFilePath()}`,
  );
  console.error(
    `[dev-tool-mcp] Extension handshake: http://127.0.0.1:${bridge.port}/handshake`,
  );

  const mcp = createMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = async () => {
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
