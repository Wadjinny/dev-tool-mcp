import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Tiny solid PNG icon (accent blue). */
function writePngIcon(path: string, size: number): void {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      if (edge) {
        raw[i] = 0x3c;
        raw[i + 1] = 0x3c;
        raw[i + 2] = 0x3c;
      } else {
        raw[i] = 0x0e;
        raw[i + 1] = 0x63;
        raw[i + 2] = 0x9c;
      }
    }
  }

  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

async function buildOnce(): Promise<void> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "background"), { recursive: true });
  mkdirSync(join(dist, "content"), { recursive: true });
  mkdirSync(join(dist, "popup"), { recursive: true });
  mkdirSync(join(dist, "icons"), { recursive: true });

  const sharedAlias = {
    "@dev-tool-mcp/shared": join(root, "../shared/src/index.ts"),
  };

  const common = {
    bundle: true as const,
    platform: "browser" as const,
    target: "chrome114",
    sourcemap: true,
    logLevel: "info" as const,
    alias: sharedAlias,
  };

  // SW + popup are ES modules; content scripts injected via
  // chrome.scripting.executeScript({ files }) must be classic/IIFE.
  await esbuild.build({
    ...common,
    entryPoints: {
      "background/sw": join(root, "background/sw.ts"),
      "popup/popup": join(root, "popup/popup.ts"),
    },
    outdir: dist,
    format: "esm",
  });

  await esbuild.build({
    ...common,
    entryPoints: {
      "content/automation": join(root, "content/automation.ts"),
    },
    outdir: dist,
    format: "iife",
  });

  cpSync(join(root, "manifest.json"), join(dist, "manifest.json"));
  cpSync(join(root, "popup/popup.html"), join(dist, "popup/popup.html"));
  cpSync(join(root, "popup/popup.css"), join(dist, "popup/popup.css"));

  for (const size of [16, 32, 48, 128]) {
    writePngIcon(join(dist, "icons", `icon${size}.png`), size);
  }

  // popup script is emitted as popup/popup.js; html references popup.js
  // already correct relative path.
}

await buildOnce();

if (watch) {
  console.log("Watching extension sources…");
  const alias = {
    "@dev-tool-mcp/shared": join(root, "../shared/src/index.ts"),
  };
  const modCtx = await esbuild.context({
    entryPoints: {
      "background/sw": join(root, "background/sw.ts"),
      "popup/popup": join(root, "popup/popup.ts"),
    },
    outdir: dist,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome114",
    sourcemap: true,
    alias,
  });
  const iifeCtx = await esbuild.context({
    entryPoints: {
      "content/automation": join(root, "content/automation.ts"),
    },
    outdir: dist,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome114",
    sourcemap: true,
    alias,
  });
  await Promise.all([modCtx.watch(), iifeCtx.watch()]);
}
