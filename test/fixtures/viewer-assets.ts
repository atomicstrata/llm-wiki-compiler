/**
 * @file test/fixtures/viewer-assets.ts
 * @description The viewer's client assets as the JSDOM harness reads them,
 * read from disk once per test file.
 *
 * Every viewer suite mounts the viewer many times, and each mount used to
 * re-read the shell, the entry script and every `viewer-*.js` module from
 * `src/viewer/assets` — roughly forty reads per mount, identical every time.
 * The assets are committed source that no test writes (harness tests mount
 * throwaway modules in memory through `mountViewerDomWith` instead), so the
 * first read's text is the text every later mount would have read. Each mount
 * still builds a fresh JSDOM from that text, so no runtime state is shared.
 */

import { readFile, readdir } from "fs/promises";
import path from "path";

const ASSETS_DIR = path.resolve("src/viewer/assets");
const assetTexts = new Map<string, Promise<string | null>>();
let assetNames: Promise<string[]> | undefined;

/** The file names in the assets directory, listed once. */
export async function viewerAssetNames(): Promise<string[]> {
  assetNames ??= readdir(ASSETS_DIR);
  return [...await assetNames];
}

/**
 * Read a file from the assets dir, returning null when it does not exist.
 * Only ENOENT is treated as "optional and absent" — a permissions error or
 * any other filesystem failure re-throws, so a broken fixture fails loudly
 * instead of silently rendering as if the file were never there.
 */
async function readFromDisk(name: string): Promise<string | null> {
  try {
    return await readFile(path.join(ASSETS_DIR, name), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One asset's text, or null when it does not exist; read once per test file. */
export function readViewerAsset(name: string): Promise<string | null> {
  const cached = assetTexts.get(name);
  if (cached !== undefined) return cached;
  const text = readFromDisk(name);
  assetTexts.set(name, text);
  return text;
}

/** One asset that must exist. */
export async function requireViewerAsset(name: string): Promise<string> {
  const text = await readViewerAsset(name);
  if (text === null) throw new Error(`viewer asset ${name} is missing from ${ASSETS_DIR}`);
  return text;
}
