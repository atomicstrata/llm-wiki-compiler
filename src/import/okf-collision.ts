/**
 * @file Collision policy for OKF import (v1: skip + warn, never overwrite). A mapped
 * slug clashes with an existing live page, a pending review candidate, or an earlier
 * doc in the same import. First (path-sorted) wins; later clashes are dropped.
 *
 * {@link filterCollisions} handles the untyped concepts/queries leg; the CLP-7.6
 * typed leg ({@link filterTypedCollisions}) applies the SAME first-wins policy over
 * the `wiki/<entityType>/<slug>.md` namespace and typed pending candidates.
 */
import { access } from "fs/promises";
import path from "path";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { listCandidates } from "../compiler/candidates.js";
import type { MappedOkfPage, MappedTypedOkfDoc, TypedImportOutcome } from "./types.js";

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
      skipped.push({ slug: page.slug, okfPath: page.okfPath, reason });
    } else { claimed.add(page.slug); kept.push(page); }
  }
  return { kept, skipped };
}

/** The full typed target key (`<entityType>/<slug>`) two docs/candidates collide on. */
function typedKey(entityType: string, slug: string): string {
  return `${entityType}/${slug}`;
}

/** The typed collision reason for a doc, or `null` when it is safe to import. */
async function typedSkipReason(
  root: string,
  doc: MappedTypedOkfDoc & { entityType: string; directory: string },
  claimed: Set<string>,
  pendingKeys: Set<string>,
): Promise<TypedImportOutcome["reason"] | null> {
  const key = typedKey(doc.entityType, doc.slug);
  if (claimed.has(key)) return "duplicate-in-bundle";
  if (pendingKeys.has(key)) return "pending-candidate";
  if (await fileExists(path.join(root, doc.directory, `${doc.slug}.md`))) return "live-page";
  return null;
}

/**
 * Partition typed docs into those safe to stage and those skipped for a collision,
 * applying the SAME first-wins policy as {@link filterCollisions} over the typed
 * `wiki/<entityType>/<slug>.md` namespace: skip when a live typed page exists at
 * that path, a pending review candidate already targets that `entityType`+`slug`,
 * or an earlier doc in this bundle already claimed it. A FALLBACK doc (no declared
 * `entityType`) is never typed-collision-checked here — it stages untyped, where
 * `writeCandidate` dedups on its own target key — so it always passes through.
 *
 * @param root - Absolute project root directory.
 * @param typed - The typed docs mapped from this bundle.
 * @returns The docs kept for staging and the collision-skip outcomes.
 */
export async function filterTypedCollisions(
  root: string,
  typed: MappedTypedOkfDoc[],
): Promise<{ kept: MappedTypedOkfDoc[]; skipped: TypedImportOutcome[] }> {
  const pending = await listCandidates(root);
  const pendingKeys = new Set(
    pending.filter((c) => c.targetEntityType).map((c) => typedKey(c.targetEntityType!, c.slug)),
  );
  const claimed = new Set<string>();
  const kept: MappedTypedOkfDoc[] = [];
  const skipped: TypedImportOutcome[] = [];
  for (const doc of typed) {
    if (doc.entityType === undefined || doc.directory === undefined) { kept.push(doc); continue; }
    const declared = doc as MappedTypedOkfDoc & { entityType: string; directory: string };
    const reason = await typedSkipReason(root, declared, claimed, pendingKeys);
    if (reason) {
      skipped.push({ okfPath: doc.okfPath, slug: doc.slug, entityType: doc.entityType, outcome: "skipped", reason });
    } else { claimed.add(typedKey(doc.entityType, doc.slug)); kept.push(doc); }
  }
  return { kept, skipped };
}
