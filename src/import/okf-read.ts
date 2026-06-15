/**
 * @file Walk an OKF bundle directory, path-confine + size-bound every file, and
 * tolerantly parse each non-reserved markdown doc into a RawOkfDoc. Reserved
 * files (index.md / log.md) and malformed/typeless docs are skipped with a warning;
 * a bundle exceeding a resource cap is rejected outright.
 *
 * The `maxFiles` cap bounds the `.md` walk EARLY: the recursion throws as soon as
 * the accumulated markdown count exceeds the limit, so a hostile deep/wide bundle is
 * rejected mid-walk rather than fully enumerated first. (Residual: a tree of many
 * empty dirs / non-`.md` files is still walked unbounded — the spec's "max files"
 * contract is the `.md` count, which is acceptable for v1.)
 */
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { parseFrontmatterStatus } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { DEFAULT_OKF_LIMITS } from "./okf-limits.js";
import type { OkfImportLimits, RawOkfDoc } from "./types.js";

const RESERVED = new Set(["index.md", "log.md"]);

/**
 * Collect bundle-relative `.md` paths. Throws as soon as the walk visits more than
 * `maxEntries` total directory entries (bounds deep/wide non-`.md` trees) or
 * accumulates more than `maxFiles` markdown files.
 */
async function listMarkdown(
  root: string,
  dir: string,
  limits: OkfImportLimits,
  acc: string[] = [],
  visited = { n: 0 },
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (++visited.n > limits.maxEntries) throw new Error(`OKF import: bundle exceeds max entry count (> ${limits.maxEntries})`);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await listMarkdown(root, abs, limits, acc, visited);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(path.relative(root, abs).split(path.sep).join("/"));
      if (acc.length > limits.maxFiles) throw new Error(`OKF import: bundle exceeds max file count (> ${limits.maxFiles})`);
    }
  }
  return acc;
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
  overrides: Partial<OkfImportLimits> = {},
  onWarn: (msg: string) => void = (m) => output.status("!", output.warn(m)),
): Promise<RawOkfDoc[]> {
  const limits = { ...DEFAULT_OKF_LIMITS, ...overrides };
  const realRoot = await safeRealpath(bundleDir);
  if (!realRoot) throw new Error(`OKF import: bundle not found: ${bundleDir}`);
  const rels = (await listMarkdown(realRoot, realRoot, limits)).sort();
  const docs: RawOkfDoc[] = [];
  let total = 0;
  for (const rel of rels) {
    if (RESERVED.has(rel)) continue;
    const real = await confinedInside(realRoot, rel);
    if (!real) { onWarn(`OKF import: skipped path escaping bundle: ${rel}`); continue; }
    const size = (await stat(real)).size;
    total += size;
    if (size > limits.maxDocBytes || total > limits.maxTotalBytes) throw new Error(`OKF import: bundle exceeds size limit at ${rel}`);
    const parsed = parseFrontmatterStatus(await readFile(real, "utf-8"));
    const type = parsed.meta.type;
    if (parsed.malformedFrontmatter || typeof type !== "string" || type.trim() === "") {
      onWarn(`OKF import: skipped doc without a valid type: ${rel}`);
      continue;
    }
    docs.push({ relPath: rel, meta: parsed.meta, body: parsed.body });
  }
  return docs;
}
