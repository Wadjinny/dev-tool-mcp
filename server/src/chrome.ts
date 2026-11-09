import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BrowserLaunchResult = {
  launched: boolean;
  command?: string;
  error?: string;
};

/** Set `DEV_TOOL_MCP_LAUNCH_CHROME=0` to stop the server opening Chrome. */
export function chromeLaunchDisabled(): boolean {
  const raw = process.env.DEV_TOOL_MCP_LAUNCH_CHROME?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/** The browser executable the user pinned, if any. */
export function configuredBrowserBin(): string | null {
  return process.env.DEV_TOOL_MCP_CHROME_BIN?.trim() || null;
}

type BrowserFamily = "chrome" | "chromium" | "brave" | "edge" | "vivaldi";

function familyOfExecutable(bin: string): BrowserFamily | null {
  const b = bin.toLowerCase();
  if (b.includes("brave")) return "brave";
  if (b.includes("msedge") || b.includes("microsoft-edge")) return "edge";
  if (b.includes("vivaldi")) return "vivaldi";
  if (b.includes("chromium")) return "chromium";
  if (b.includes("chrome")) return "chrome";
  return null;
}

const FAMILY_PROCESS: Record<BrowserFamily, RegExp> = {
  chrome: /(?:google[- ]chrome|(?:^|[\\/])chrome(?:\.exe)?$|^chrome$)/i,
  chromium: /chromium/i,
  brave: /brave/i,
  edge: /(?:msedge|microsoft[- ]edge)/i,
  vivaldi: /vivaldi/i,
};

/** Helpers/daemons that can outlive the browser and must not count as "open". */
const HELPER_PROCESS =
  /crashpad|crash[_-]reporter|crash-handler|chromedriver|headless[_-]shell/i;

/**
 * Best-effort check for a running browser. When `bin` is given, only that
 * browser family counts — a running Edge/Brave must not suppress launching the
 * Chrome the user asked for. Defaults to Chrome/Chromium.
 */
export async function isBrowserRunning(bin?: string | null): Promise<boolean> {
  const family = bin ? familyOfExecutable(bin) : null;
  // An explicit but unrecognised executable cannot be detected; try launching
  // it rather than silently assuming it is already up.
  if (bin && !family) return false;

  const matchers = family
    ? [FAMILY_PROCESS[family]]
    : [FAMILY_PROCESS.chrome, FAMILY_PROCESS.chromium];

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FO", "CSV", "/NH"],
        { timeout: 3_000 },
      );
      return stdout
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .some(
          (name) =>
            !HELPER_PROCESS.test(name) &&
            matchers.some((re) => re.test(name)),
        );
    }
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "comm="], {
      timeout: 3_000,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .some(
        (name) =>
          !HELPER_PROCESS.test(name) &&
          matchers.some((re) => re.test(name)),
      );
  } catch {
    // If we cannot inspect processes, let the launch attempt decide.
    return false;
  }
}

function launchArgs(): string[] {
  const args = ["--no-first-run", "--no-default-browser-check"];

  const profile = process.env.DEV_TOOL_MCP_CHROME_PROFILE?.trim();
  if (profile) args.push(`--profile-directory=${profile}`);

  const userDataDir = process.env.DEV_TOOL_MCP_CHROME_USER_DATA_DIR?.trim();
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);

  // Optional: force-load this build of the unpacked extension (Chromium and
  // Chrome for Testing honour it; branded Chrome may ignore it).
  const extension = process.env.DEV_TOOL_MCP_CHROME_EXTENSION?.trim();
  if (extension) {
    args.push(
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
    );
  }

  // Extra flags, e.g. DEV_TOOL_MCP_CHROME_ARGS="--start-maximized".
  const extra = process.env.DEV_TOOL_MCP_CHROME_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  return args;
}

/** Spawn a detached browser and resolve once it has actually started. */
function spawnDetached(
  command: string,
  args: string[],
): Promise<BrowserLaunchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    const done = (result: BrowserLaunchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (err) => {
      done({ launched: false, command, error: err.message });
    });
    child.once("spawn", () => {
      child.unref();
      done({ launched: true, command });
    });
  });
}

async function launchOnMac(): Promise<BrowserLaunchResult> {
  const args = launchArgs();

  // An explicitly configured binary must win on macOS too.
  const explicit = configuredBrowserBin();
  if (explicit) {
    return spawnDetached(explicit, args);
  }

  const apps = [
    "Google Chrome",
    "Chromium",
    "Brave Browser",
    "Microsoft Edge",
    "Vivaldi",
  ];
  let lastError = "no supported browser found";
  for (const app of apps) {
    try {
      // `--args` forwards the profile/flags when this starts the app.
      await execFileAsync("open", ["-a", app, "--args", ...args], {
        timeout: 5_000,
      });
      return {
        launched: true,
        command: `open -a "${app}" --args ${args.join(" ")}`,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { launched: false, error: lastError };
}

function launchCandidates(): string[] {
  const explicit = configuredBrowserBin();
  if (explicit) return [explicit];

  if (process.platform === "win32") {
    const roots = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
      process.env["LOCALAPPDATA"],
    ].filter((root): root is string => !!root);
    return [
      ...roots.map(
        (root) =>
          `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      ),
      ...roots.map(
        (root) =>
          `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ),
      "chrome.exe",
      "msedge.exe",
    ];
  }

  return [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "brave",
    "microsoft-edge-stable",
    "microsoft-edge",
    "vivaldi-stable",
    "vivaldi",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
  ];
}

/**
 * Open Chrome with the user's normal profile (so the installed extension and
 * its granted permissions are used) and any configured profile/args.
 */
export async function launchBrowser(): Promise<BrowserLaunchResult> {
  if (process.platform === "darwin") return launchOnMac();

  const args = launchArgs();
  let lastError = "no supported browser found";
  for (const candidate of launchCandidates()) {
    const result = await spawnDetached(candidate, args);
    if (result.launched) return result;
    lastError = result.error ?? lastError;
  }
  return { launched: false, error: lastError };
}
