/**
 * @file src/utils/evidence-path.ts
 * @description Shared predicate for safe project-relative evidence paths used by
 * BOTH relation citation (`sourcePath`) and rule-candidate file evidence (`path`).
 *
 * Combines the absolute/drive/UNC/`..` rejection from the rule-candidate pipeline
 * with the per-segment {@link isSafeFilenameComponent} floor from the relation
 * evidence validator so BOTH surfaces are strictly consistent — one helper, no drift.
 *
 * Rejected forms:
 *   - POSIX absolute (`/…`)
 *   - Backslash-absolute (`\…`)
 *   - Windows drive-absolute (`C:/…`, `C:\…`, etc.)
 *   - UNC roots (`//host` or `\\host` — leading empty segment from `//` or `\\`)
 *   - Any `..` or `.` segment (traversal or self-reference)
 *   - Any empty segment (consecutive separators, trailing `/`)
 *   - Any segment failing {@link isSafeFilenameComponent} (NUL, space, leading-dot)
 *   - Paths over {@link EVIDENCE_PATH_CAP} characters
 *   - Any `:` anywhere in the path (Windows drive-colon in non-first segment, NTFS ADS)
 */

import { isSafeFilenameComponent } from "../profile/identity.js";

/**
 * Maximum character length for a safe evidence path. Matches the rule-candidate
 * `EVIDENCE_REF_CAP` and the former relation-contract `MAX_SOURCE_PATH_CHARS` —
 * both capped at 1 024 characters.
 */
const EVIDENCE_PATH_CAP = 1024;

/**
 * True when `p` is a safe project-relative evidence path: non-empty, within
 * {@link EVIDENCE_PATH_CAP} characters, free of absolute/drive/UNC roots and `..`
 * traversal, and every segment passes the {@link isSafeFilenameComponent} floor
 * (no NUL, space, leading-dot, or path separators).
 *
 * This is the SINGLE shared predicate for rule-candidate file evidence AND relation
 * citation `sourcePath` — both surfaces call this so they can never disagree.
 *
 * @param p - The candidate evidence path.
 * @returns Whether the path is safe and project-relative.
 */
export function isSafeRelativeEvidencePath(p: string): boolean {
  if (p.length === 0 || p.length > EVIDENCE_PATH_CAP) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // Windows drive-absolute (C:/ or C:\)
  // Reject ':' anywhere: drive-colon in a non-first segment (sources/C:/…) and
  // NTFS alternate data stream syntax (file.md:ads) are both Windows-dangerous.
  // Slugified source filenames never contain ':', so legit paths are unaffected.
  if (p.includes(":")) return false;
  // Split on both separators so a mixed path can't sneak a drive segment through.
  // isSafeFilenameComponent rejects empty, "..", ".", NUL, space, and leading-dot.
  return p.split(/[/\\]/).every((seg) => isSafeFilenameComponent(seg));
}
