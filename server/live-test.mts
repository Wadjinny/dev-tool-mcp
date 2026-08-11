/**
 * Live integration probe against the built MCP server + Connected extension.
 * Spawns server on an alternate WS port; prints instructions if extension
 * is not on that port. Prefer probing the already-running Cursor MCP via
 * tools/list over stdio by attaching as a client... we instead call the
 * extension through a short-lived server after rebinding.
 *
 * Usage:
 *   DEV_TOOL_MCP_WS_PORT=17375 pnpm exec tsx live-test.mts
 *
 * For Cursor-managed server (port 17373), this script uses the MCP SDK
 * Client over a spawned stdio process on 17375 and expects you to flip
 * the extension port OR uses HTTP handshake only to validate tool schemas.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.DEV_TOOL_MCP_WS_PORT || "17375";

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "dist", "index.js")],
  env: {
    ...process.env,
    DEV_TOOL_MCP_WS_PORT: port,
  },
});

const client = new Client({ name: "live-test", version: "0.0.1" });
await client.connect(transport);

const listed = await client.listTools();
const names = listed.tools.map((t) => t.name).sort();
const required = [
  "browser_pin_inspect",
  "devtools_network_for_pin",
  "devtools_network_request",
  "devtools_network_requests",
  "devtools_evaluate",
  "devtools_cdp",
];

console.log("=== tools/list ===");
for (const n of required) {
  console.log(`${names.includes(n) ? "OK" : "MISSING"} ${n}`);
}

const netTool = listed.tools.find((t) => t.name === "devtools_network_requests");
const props = (netTool?.inputSchema as { properties?: Record<string, unknown> })
  ?.properties;
console.log(
  "network schema has waitForMs:",
  !!props?.waitForMs,
  "host:",
  !!props?.host,
  "resourceKind:",
  !!props?.resourceKind,
);

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { isError: result.isError === true, parsed };
}

console.log("\n=== browser_tabs ===");
const tabs = await call("browser_tabs", {});
console.log(JSON.stringify(tabs.parsed, null, 2));

if (
  tabs.isError ||
  (tabs.parsed &&
    typeof tabs.parsed === "object" &&
    "code" in (tabs.parsed as object) &&
    (tabs.parsed as { code?: string }).code === "EXTENSION_DISCONNECTED")
) {
  console.log(`\nExtension not on WS port ${port}.`);
  console.log(
    "In the extension popup, set port to",
    port,
    "or reconnect after pointing storage wsPort, then re-run.",
  );
  console.log(
    "Alternatively keep Cursor MCP on 17373, reload MCP tools in Cursor, and test there.",
  );
  await client.close();
  process.exit(2);
}

console.log("\n=== browser_pins ===");
const pinsRes = await call("browser_pins", {});
console.log(JSON.stringify(pinsRes.parsed, null, 2));
const pins =
  pinsRes.parsed &&
  typeof pinsRes.parsed === "object" &&
  "pins" in (pinsRes.parsed as object)
    ? ((pinsRes.parsed as { pins: Array<{ id: string; tag: string }> }).pins ??
      [])
    : [];

console.log("\n=== devtools_attach ===");
console.log(JSON.stringify((await call("devtools_attach")).parsed, null, 2));

console.log("\n=== Target.getTargets (allowlist) ===");
console.log(
  JSON.stringify(
    (await call("devtools_cdp", { method: "Target.getTargets" })).parsed,
    null,
    2,
  ),
);

console.log("\n=== devtools_network_requests (rich) ===");
const net = await call("devtools_network_requests", {
  limit: 5,
  resourceKind: "http",
});
console.log(JSON.stringify(net.parsed, null, 2).slice(0, 2500));

console.log("\n=== devtools_evaluate isolated (CSP fallback on Teams) ===");
const ev = await call("devtools_evaluate", {
  expression: "location.hostname",
  world: "isolated",
});
console.log(JSON.stringify(ev.parsed, null, 2));

if (pins[0]) {
  const pinId = pins[0].id;
  console.log(`\n=== browser_pin_inspect ${pinId} ===`);
  console.log(
    JSON.stringify((await call("browser_pin_inspect", { pin: pinId })).parsed, null, 2).slice(
      0,
      2500,
    ),
  );

  console.log(`\n=== devtools_network_for_pin ${pinId} ===`);
  console.log(
    JSON.stringify(
      (await call("devtools_network_for_pin", { pin: pinId })).parsed,
      null,
      2,
    ).slice(0, 2500),
  );

  console.log(`\n=== evaluate with pin ${pinId} ===`);
  console.log(
    JSON.stringify(
      (
        await call("devtools_evaluate", {
          expression: "el.tagName + ':' + (el.getAttribute('src')||el.getAttribute('aria-label')||'')",
          pin: pinId,
          world: "main",
        })
      ).parsed,
      null,
      2,
    ),
  );
} else {
  console.log("\nNo pins — skip pin_inspect / network_for_pin / evaluate-by-pin.");
  console.log("Pin an element in the popup, then re-run.");
}

await client.close();
console.log("\nDone.");
