import { createMcpServer } from "./src/mcp.ts";
const server = createMcpServer() as any;
const tools = server._registeredTools;
if (!tools) {
  console.error("no _registeredTools", Object.keys(server));
  process.exit(1);
}
console.log(Object.keys(tools).sort().join("\n"));
console.log("---");
console.log("browser_click desc:", tools.browser_click?.description);
console.log("has browser_pins:", !!tools.browser_pins);
