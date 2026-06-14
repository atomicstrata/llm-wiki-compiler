/**
 * @file Walk an OKF bundle directory, path-confine + size-bound every file, and
 * tolerantly parse each non-reserved markdown doc into a RawOkfDoc. Reserved
 * files (index.md / log.md) and malformed/typeless docs are skipped with a warning;
 * a bundle exceeding a resource cap is rejected outright.
 */
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { parseFrontmatterStatus } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { DEFAULT_OKF_LIMITS } from "./okf-limits.js";
import type { OkfImportLimits, RawOkfDoc } from "./types.js";

const RESERVED = new Set(["index.md", "log.md"]);

async function listMarkdown(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(root, abs)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Resolve `realRoot/rel` to its real path IFF that realpath stays within `realRoot`.
 * Returns null when the entry is missing or its realpath escapes the bundle (e.g. a
 * symlink pointing outside). Exported so the confinement guard is unit-testable
 * directly — `listMarkdown`'s `isFile()` filter would otherwise mask this path.
 */
export async function confinedInside(realRoot: string, rel: string): Promise<string | null> {
  const real = await safeRealpath(path.join(realRoot, rel));
  return real && isInsideDir(real, realRoot) ? real : null;
}

/** Read + parse an OKF bundle. Returns concept docs only (reserved + invalid skipped). */
export async function readOkfBundle(
  bundleDir: string,
  _cwdRoot: string,
  overrides: Partial<OkfImportLimits> = {},
): Promise<RawOkfDoc[]> {
  const limits = { ...DEFAULT_OKF_LIMITS, ...overrides };
  const realRoot = await safeRealpath(bundleDir);
  if (!realRoot) throw new Error(`OKF import: bundle not found: ${bundleDir}`);
  const rels = (await listMarkdown(realRoot, realRoot)).sort();
  if (rels.length > limits.maxFiles) throw new Error(`OKF import: bundle exceeds max file count (${rels.length} > ${limits.maxFiles})`);
  const docs: RawOkfDoc[] = [];
  let total = 0;
  for (const rel of rels) {
    if (RESERVED.has(rel)) continue;
    const real = await confinedInside(realRoot, rel);
    if (!real) { output.status("!", output.warn(`OKF import: skipped path escaping bundle: ${rel}`)); continue; }
    const size = (await stat(real)).size;
    total += size;
    if (size > limits.maxDocBytes || total > limits.maxTotalBytes) throw new Error(`OKF import: bundle exceeds size limit at ${rel}`);
    const parsed = parseFrontmatterStatus(await readFile(real, "utf-8"));
    const type = parsed.meta.type;
    if (parsed.malformedFrontmatter || typeof type !== "string" || type.trim() === "") {
      output.status("!", output.warn(`OKF import: skipped doc without a valid type: ${rel}`));
      continue;
    }
    docs.push({ relPath: rel, meta: parsed.meta, body: parsed.body });
  }
  return docs;
}
