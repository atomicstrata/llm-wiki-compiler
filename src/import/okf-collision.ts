/**
 * @file Collision policy for OKF import (v1: skip + warn, never overwrite). A mapped
 * slug clashes with an existing live page, a pending review candidate, or an earlier
 * doc in the same import. First (path-sorted) wins; later clashes are dropped.
 */
import { access } from "fs/promises";
import path from "path";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { listCandidates } from "../compiler/candidates.js";
import * as output from "../utils/output.js";
import type { MappedOkfPage } from "./types.js";

/** A dropped doc + why, for caller reporting. */
export interface SkippedOkfPage { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle"; }

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Partition mapped pages into those safe to import and those skipped for a collision. */
export async function filterCollisions(
  root: string,
  pages: MappedOkfPage[],
): Promise<{ kept: MappedOkfPage[]; skipped: SkippedOkfPage[] }> {
  const pendingSlugs = new Set((await listCandidates(root)).map((c) => c.slug));
  const claimed = new Set<string>();
  const kept: MappedOkfPage[] = [];
  const skipped: SkippedOkfPage[] = [];
  for (const page of pages) {
    let reason: SkippedOkfPage["reason"] | null = null;
    if (claimed.has(page.slug)) reason = "duplicate-in-bundle";
    else if (pendingSlugs.has(page.slug)) reason = "pending-candidate";
    else if (await fileExists(path.join(root, CONCEPTS_DIR, `${page.slug}.md`)) ||
             await fileExists(path.join(root, QUERIES_DIR, `${page.slug}.md`))) reason = "live-page";
    if (reason) {
      output.status("!", output.warn(`OKF import: skipped ${page.okfPath} (slug "${page.slug}" collides: ${reason})`));
      skipped.push({ slug: page.slug, okfPath: page.okfPath, reason });
    } else { claimed.add(page.slug); kept.push(page); }
  }
  return { kept, skipped };
}
