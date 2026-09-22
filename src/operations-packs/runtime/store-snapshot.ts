/**
 * @file src/operations-packs/runtime/store-snapshot.ts
 * @description The current-store snapshot a `reconcile` phase compares its
 * proposals against (design section 16.6): the profile-class entity pages of ONE
 * declared entity type, projected onto the closed evidence-item shape the pure
 * reconcile handler consumes.
 *
 * IDENTITY IS THE PAGE SLUG, DELIBERATELY. A proposed item's identity is its
 * evidence item id, and the id of the item an intent phase drafts from is what
 * becomes the created page's SLUG — so comparing proposed ids against current
 * slugs asks exactly the AS-1 question: "does the page this proposal would
 * create already exist?" The snapshot is scoped to the phase body's
 * `comparedEvidenceClass` (a profile entity type under `wiki/<entityType>`),
 * so two types sharing a slug never collide across types.
 *
 * THE COMPARED CLASS MUST BE A DECLARED ENTITY TYPE of a NON-DEFAULT effective
 * profile. An undeclared class REFUSES rather than yielding a permanently-empty
 * snapshot, because that emptiness would classify a real collision `absent`: a
 * wrong answer where a refusal belongs. The built-in default profile refuses
 * too — its page enumerator is a different primitive with different identity
 * semantics, and a production pack action always runs under an activated
 * product's own (non-default) profile. The one truthful empty snapshot is a
 * declared type with zero pages.
 *
 * "COULDN'T READ" IS NEVER "DOESN'T EXIST" — AT EVERY LEG. A profile that fails
 * to load, or an entity collection reporting ANY problem, REFUSES the snapshot.
 * The collector also has SILENT legs the problem list never sees: an unreadable
 * page file and a symlinked/confinement-failed leaf are dropped from the scan
 * without a problem, and a page whose YAML frontmatter is malformed still
 * becomes a page with EMPTY frontmatter. So the snapshot re-scans the compared
 * directory through the collector's own scan primitive and refuses when the
 * directory's `.md` entry count disagrees with the scan (a file vanished
 * unread) or any scan is flagged `malformedFrontmatter` (its fields would
 * compare as empty, not as what the page says). A page that exists but could
 * not be read or parsed must never be reported `absent` — or compared as blank.
 *
 * FIELDS ARE THE SCALAR FRONTMATTER. The reconcile handler compares closed
 * scalar field records; non-scalar frontmatter values (lists, records) and
 * NON-FINITE numbers (YAML `.inf`/`.nan`, which the canonical serializer
 * refuses) are OMITTED deterministically rather than serialized, so two runs
 * over one page always see the same projection.
 */

import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectEntityPagesWithMessages, loadNonDefaultProfile } from "../../profile/block.js";
import { ProfileValidationError } from "../../profile/errors.js";
import { ProfileLoadError } from "../../profile/load.js";
import type { EntityPage, LoadedProfile } from "../../profile/types.js";
import {
  ActiveProductUnavailableError, ProductAuthorityConflictError,
} from "../../products/binding/problems.js";
import { scanEntityDir } from "../../wiki/collect.js";
import type { PackEvidenceItemV1, PackEvidenceScalarV1 } from "../handlers/types.js";

/** One snapshot: the compared type's current items, or why it could not be taken. */
export type PackStoreSnapshotV1 =
  | { readonly kind: "ok"; readonly items: readonly PackEvidenceItemV1[] }
  | { readonly kind: "refused"; readonly detail: string };

/** The documented load-failure classes; every one means "unreadable", not "absent". */
function isProfileLoadFailure(cause: unknown): boolean {
  return cause instanceof ProfileLoadError
    || cause instanceof ProfileValidationError
    || cause instanceof ActiveProductUnavailableError
    || cause instanceof ProductAuthorityConflictError;
}

/** The scalar projection of one page's frontmatter; non-scalar values omitted. */
function scalarFrontmatter(frontmatter: Readonly<Record<string, unknown>>): Record<string, PackEvidenceScalarV1> {
  const fields: Record<string, PackEvidenceScalarV1> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    // Non-finite numbers are non-scalar here: RFC 8785 canonicalization refuses
    // them, so admitting one would throw out of the leg instead of refusing.
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * The reserved fields carrying a snapshot page's ON-DISK identity.
 *
 * They are what an authored UPDATE uses as its precondition, so they must be
 * the digest of the BYTES THE STORE ACTUALLY HOLDS. Re-serializing frontmatter
 * and body would produce a digest that never matches the file, and every update
 * would park — safe, and uselessly so.
 */
export const CURRENT_DIGEST_FIELD = "current-digest";
export const CURRENT_BYTES_FIELD = "current-byte-count";

/** One entity page as the closed evidence item the reconcile handler compares. */
async function snapshotItem(page: EntityPage): Promise<PackEvidenceItemV1> {
  const bytes = await readFile(page.filePath);
  return {
    itemId: page.slug,
    fields: {
      ...scalarFrontmatter(page.frontmatter),
      [CURRENT_DIGEST_FIELD]: createHash("sha256").update(bytes).digest("hex"),
      [CURRENT_BYTES_FIELD]: bytes.byteLength,
    },
  };
}

/**
 * Refuse the silent scan legs for the compared directory: an unreadable page
 * file or a symlinked/confinement-failed leaf is DROPPED from the scan without
 * a problem (the `.md` entry count disagreeing with the scan is the witness),
 * and a malformed-YAML page scans "successfully" with empty frontmatter. Both
 * would make an existing page compare wrong — vanished or blank — so both
 * refuse. This is the collector's own scan primitive, re-run, not a second
 * enumeration rule.
 */
async function scanHealthProblem(root: string, directory: string): Promise<string | null> {
  const { scans, dirStatus } = await scanEntityDir(root, directory);
  if (dirStatus === "invalid") return "the compared entity directory is invalid";
  let entryCount = 0;
  try {
    entryCount = (await readdir(path.join(root, directory))).filter((file) => file.endsWith(".md")).length;
  } catch {
    entryCount = 0; // absent directory: zero entries, zero scans — healthy.
  }
  if (entryCount !== scans.length) {
    return "a page file in the compared entity directory could not be read";
  }
  if (scans.some((scan) => scan.parseStatus.malformedFrontmatter)) {
    return "a page in the compared entity directory has malformed frontmatter";
  }
  return null;
}

/** Collect the compared type's pages, refusing a collection with ANY problem. */
async function collectSnapshot(
  root: string, loaded: LoadedProfile, entityType: string,
): Promise<PackStoreSnapshotV1> {
  const { pages, problems } = await collectEntityPagesWithMessages(root, loaded);
  if (problems.length > 0) {
    return { kind: "refused", detail: `the entity-page snapshot is incomplete (${problems.length} collection problems)` };
  }
  const directory = loaded.profile.entities[entityType]!.directory;
  const unhealthy = await scanHealthProblem(root, directory);
  if (unhealthy !== null) return { kind: "refused", detail: unhealthy };
  const items = await Promise.all(
    pages.filter((page) => page.entityType === entityType).map(snapshotItem));
  return { kind: "ok", items };
}

/**
 * Take the current-store snapshot for one reconcile phase.
 *
 * @param root - The project root whose entity pages are enumerated.
 * @param entityType - The phase body's `comparedEvidenceClass`: the profile
 *   entity type whose pages the proposals are compared against.
 * @returns The compared type's current items keyed by slug — empty ONLY for a
 *   declared type with zero pages — or a refusal when the class is undeclared,
 *   the effective profile is the built-in default, or the profile or any page
 *   is unreadable.
 */
export async function packStoreSnapshot(root: string, entityType: string): Promise<PackStoreSnapshotV1> {
  let loaded: LoadedProfile | undefined;
  try {
    loaded = await loadNonDefaultProfile(root);
  } catch (cause) {
    if (isProfileLoadFailure(cause)) return { kind: "refused", detail: "the project profile is unreadable" };
    throw cause;
  }
  if (loaded === undefined) {
    return { kind: "refused", detail: "reconcile compares against a product profile's entity pages; the built-in default profile is not one" };
  }
  if (loaded.profile.entities[entityType] === undefined) {
    return { kind: "refused", detail: `compared evidence class ${JSON.stringify(entityType)} is not a declared entity type` };
  }
  return collectSnapshot(root, loaded, entityType);
}
