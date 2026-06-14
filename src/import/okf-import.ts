/**
 * @file Orchestrate an OKF import: read the bundle (confined + bounded), invert each
 * doc to a llmwiki page, then apply the collision policy. Side-effect free with respect
 * to wiki/ — the caller (command) decides to stage as candidates or write live.
 */
import path from "path";
import { slugify } from "../utils/markdown.js";
import { readOkfBundle } from "./okf-read.js";
import { okfDocToPage, slugFromRelPath } from "./okf-map.js";
import { filterCollisions } from "./okf-collision.js";
import type { OkfImportLimits, MappedOkfPage, RawOkfDoc } from "./types.js";
import type { SkippedOkfPage } from "./okf-collision.js";

/** Stable, filesystem-safe bundle id derived from the bundle directory name. */
function bundleIdFor(bundleDir: string): string {
  return slugify(path.basename(path.resolve(bundleDir))) || "bundle";
}

/** Build a slug->title resolver over the whole bundle so intra-bundle links reverse cleanly. */
function titleResolver(docs: RawOkfDoc[]): (slug: string) => string | null {
  const map = new Map<string, string>();
  for (const d of docs) {
    const slug = slugFromRelPath(d.relPath);
    if (typeof d.meta.title === "string") map.set(slug, d.meta.title);
  }
  return (slug) => map.get(slug) ?? null;
}

/** Read + map + collision-filter an OKF bundle into stage-ready pages. */
export async function importOkfBundle(
  bundleDir: string,
  root: string,
  overrides: Partial<OkfImportLimits> = {},
): Promise<{ pages: MappedOkfPage[]; skipped: SkippedOkfPage[] }> {
  const docs = await readOkfBundle(bundleDir, overrides);
  const ctx = { bundleId: bundleIdFor(bundleDir), titleOf: titleResolver(docs) };
  const mapped = docs.map((d) => okfDocToPage(d, ctx));
  const { kept, skipped } = await filterCollisions(root, mapped);
  return { pages: kept, skipped };
}
