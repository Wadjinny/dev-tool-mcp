/** Domains allowed for raw `devtools_cdp` / debugger.sendCommand. */
export const CDP_ALLOWED_DOMAINS = [
  "Runtime",
  "Console",
  "Network",
  "DOM",
  "CSS",
  "Page",
  "DOMStorage",
  "Input",
  "Overlay",
  "Accessibility",
] as const;

const DENIED_EXACT = new Set([
  "Target.createBrowserContext",
  "Target.closeTarget",
  "Target.attachToBrowserTarget",
  "Browser.close",
  "Browser.crash",
  "Browser.grantPermissions",
  "SystemInfo.getInfo",
]);

export function isCdpMethodAllowed(method: string): boolean {
  if (!method || method.includes("..") || method.startsWith("Browser.")) {
    return false;
  }
  if (DENIED_EXACT.has(method)) {
    return false;
  }
  const domain = method.split(".")[0];
  return (CDP_ALLOWED_DOMAINS as readonly string[]).includes(domain);
}
