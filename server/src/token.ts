import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function tokenPath(): string {
  return (
    process.env.DEV_TOOL_MCP_TOKEN_FILE ??
    join(homedir(), ".config", "dev-tool-mcp", "token")
  );
}

function portPath(): string {
  return join(dirname(tokenPath()), "port");
}

export function getPortFilePath(): string {
  return portPath();
}

/**
 * Record the port we actually bound, so the port stays discoverable when a
 * conflict pushed us off the default. Best-effort: never fail startup on this.
 */
export async function writePortFile(port: number): Promise<void> {
  try {
    const path = portPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${port}\n`, { mode: 0o600 });
  } catch {
    // discovery hint only
  }
}

/** Remove the port file, but only if it still advertises our own port. */
export async function clearPortFile(port: number): Promise<void> {
  try {
    const path = portPath();
    const current = (await readFile(path, "utf8")).trim();
    if (current === String(port)) {
      await rm(path, { force: true });
    }
  } catch {
    // nothing to clean up
  }
}

export async function loadOrCreateToken(): Promise<string> {
  if (process.env.DEV_TOOL_MCP_TOKEN) {
    return process.env.DEV_TOOL_MCP_TOKEN;
  }

  const path = tokenPath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 16) {
      return existing;
    }
  } catch {
    // create below
  }

  const token = randomBytes(24).toString("base64url");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function getTokenFilePath(): string {
  return tokenPath();
}
