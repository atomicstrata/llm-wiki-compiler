/**
 * @file The TYPED profile-entity leg of OKF import (CLP 7.6 Task 4, guardrail F4 /
 * Invariant 4).
 *
 * When a project runs a NON-DEFAULT profile, a bundle doc whose rel-path first
 * segment names an ACTIVE-profile entity type — or whose `x-llmwiki.entityType`
 * does — is a TYPED entity record, NOT a plain concept. Such a record must ONLY
 * ever land through typed validation + the trust planner; the legacy trusted
 * write path (`writeAll` in `run.ts`) is NEVER taken for it. This module owns:
 *
 *  - {@link partitionProfileDocs}: split a bundle's docs into the untyped `native`
 *    docs (unchanged legacy path) and the `typed` docs, resolving each typed doc's
 *    entity type (path prefix WINS over `x-llmwiki.entityType`, warn on
 *    disagreement) against the loaded profile and reconstructing its typed page.
 *  - {@link applyTypedDocs}: stage each typed doc through {@link stageEntityPage}
 *    (`imported` review candidate, `imported-okf` held reason). Under `--trusted`
 *    it additionally promotes the just-staged candidate via the LOCK-FREE
 *    {@link applyTypedCandidate} (the import lock is already held, so
 *    `promoteCandidateUnderLock` would deadlock). A contract/lifecycle violation at
 *    staging, an unknown type, or a promotion refusal NEVER goes live: it falls
 *    back to untyped staging (D-7.6.5) or leaves the typed candidate staged for
 *    review — fail to review, never fail open.
 *  - {@link previewTypedOutcomes}: the dry-run projection (no I/O).
 *
 * DEFAULT PARITY (D-7.6.10): the caller only invokes this leg when
 * {@link loadNonDefaultProfile} returns a non-default profile, so a default-profile
 * project routes every doc through the untyped path exactly as before.
 */

import { buildFrontmatter } from "../utils/markdown.js";
import {
  okfDocToPage,
  buildXokf,
  reverseDocBody,
  slugFromRelPath,
  type OkfMapContext,
} from "./okf-map.js";
import {
  stageEntityPage,
  UnknownEntityTypeError,
  BlockedStagedWriteError,
  EntityFieldContractError,
  LifecycleTransitionError,
} from "../trust/staging.js";
import { applyTypedCandidate } from "../trust/promote.js";
import { writeCandidate, readCandidate, deleteCandidate } from "../compiler/candidates.js";
import type { EntityTypeDef, ProfilePack } from "../profile/types.js";
import type { HeldReason } from "../review/policy.js";
import type { MappedTypedOkfDoc, RawOkfDoc, TypedImportOutcome } from "./types.js";

/** OKF standard / reserved frontmatter keys that map back explicitly, not as domain fields. */
const RESERVED_OKF_KEYS = new Set(["type", "x-llmwiki", "x-okf", "title", "description", "tags", "timestamp"]);

/** True for a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How one doc's entity type resolved: a typed target, an unknown-type fallback, or `null` (untyped). */
interface EntityResolution {
  entityType?: string;
  slug: string;
  fallbackReason?: string;
}

/** Derive the typed slug for a path-prefix match by stripping the `<entityType>/` segment. */
function slugFromEntityPath(relPath: string, entityType: string): string {
  return slugFromRelPath(relPath.slice(entityType.length + 1));
}

/**
 * Resolve a doc's entity type against the active-profile entity keys, per D-7.6.4:
 * a rel-path first segment naming a declared type WINS (warn if `x-llmwiki.entityType`
 * disagrees); otherwise a declared `x-llmwiki.entityType` names it; a PRESENT but
 * undeclared `x-llmwiki.entityType` is an unknown-type fallback (D-7.6.5). Returns
 * `null` when the doc is a plain untyped concept/query (the legacy path).
 */
function resolveEntityType(
  doc: RawOkfDoc,
  keys: Set<string>,
  onWarn: (msg: string) => void,
): EntityResolution | null {
  const firstSeg = doc.relPath.split("/")[0]!;
  const x = doc.meta["x-llmwiki"];
  const declared = isRecord(x) && typeof x.entityType === "string" ? x.entityType : undefined;
  if (keys.has(firstSeg)) {
    if (declared !== undefined && declared !== firstSeg) {
      onWarn(`OKF import: entity-type mismatch on ${doc.relPath}: path "${firstSeg}" vs x-llmwiki.entityType "${declared}"; using path`);
    }
    return { entityType: firstSeg, slug: slugFromEntityPath(doc.relPath, firstSeg) };
  }
  if (declared === undefined) return null;
  if (keys.has(declared)) return { entityType: declared, slug: slugFromRelPath(doc.relPath) };
  onWarn(`OKF import: unknown entity type "${declared}" on ${doc.relPath}; staging as an untyped review candidate`);
  return { slug: slugFromRelPath(doc.relPath), fallbackReason: `unknown entity type "${declared}"` };
}

/** Copy the entered lifecycle state onto the reconstructed fields, from a domain field or the x-llmwiki block. */
function applyImportedLifecycle(fields: Record<string, unknown>, meta: Record<string, unknown>, def: EntityTypeDef): void {
  const lifecycle = def.lifecycle;
  if (!lifecycle || fields[lifecycle.field] !== undefined) return;
  const x = meta["x-llmwiki"];
  const lc = isRecord(x) ? x.lifecycle : undefined;
  if (isRecord(lc) && lc.field === lifecycle.field && typeof lc.state === "string") {
    fields[lifecycle.field] = lc.state;
  }
}

/**
 * Reconstruct a typed page's frontmatter from an OKF doc: the entity's own domain
 * frontmatter fields verbatim, the OKF standard fields mapped back
 * (title/description→summary/tags/timestamp→updatedAt), the lifecycle state, and
 * the `x-okf` re-export-honesty snapshot (D-7.6.12).
 */
function buildTypedPageFields(meta: Record<string, unknown>, def: EntityTypeDef, okfPath: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!RESERVED_OKF_KEYS.has(key)) fields[key] = value;
  }
  if (typeof meta.title === "string") fields.title = meta.title;
  if (typeof meta.description === "string") fields.summary = meta.description;
  if (Array.isArray(meta.tags)) fields.tags = meta.tags;
  if (typeof meta.timestamp === "string") fields.updatedAt = meta.timestamp;
  applyReservedDomainFields(fields, meta);
  applyImportedLifecycle(fields, meta, def);
  fields["x-okf"] = buildXokf(meta, okfPath);
  return fields;
}

/**
 * Restore the reserved-name-collision domain fields the exporter parked under
 * `x-llmwiki.fields` (D-7.6.3). These WIN over the top-level copy on the same key:
 * a `description`/`tags`/… DOMAIN field is authoritative over the OKF standard
 * mapping, so the entity's own field value round-trips verbatim.
 */
function applyReservedDomainFields(fields: Record<string, unknown>, meta: Record<string, unknown>): void {
  const x = meta["x-llmwiki"];
  const xfields = isRecord(x) ? x.fields : undefined;
  if (!isRecord(xfields)) return;
  for (const [key, value] of Object.entries(xfields)) fields[key] = value;
}

/** Build the full reconstructed typed page (frontmatter + reversed body) for staging. */
function buildTypedPageBody(doc: RawOkfDoc, def: EntityTypeDef, ctx: OkfMapContext): string {
  const fields = buildTypedPageFields(doc.meta, def, doc.relPath);
  return `${buildFrontmatter(fields)}\n${reverseDocBody(doc, ctx)}`;
}

/** Map one resolved typed doc to its {@link MappedTypedOkfDoc} (typed page + untyped fallback form). */
function mapTypedDoc(
  doc: RawOkfDoc,
  resolution: EntityResolution,
  profile: ProfilePack,
  ctx: OkfMapContext,
): MappedTypedOkfDoc {
  const untyped = okfDocToPage(doc, ctx);
  if (resolution.entityType === undefined) {
    return { slug: resolution.slug, okfPath: doc.relPath, untyped, fallbackReason: resolution.fallbackReason };
  }
  const def = profile.entities[resolution.entityType]!;
  return {
    entityType: resolution.entityType,
    directory: def.directory,
    slug: resolution.slug,
    okfPath: doc.relPath,
    typedBody: buildTypedPageBody(doc, def, ctx),
    untyped,
  };
}

/**
 * Split a bundle's docs into the untyped `native` docs (routed through the legacy
 * concept/query path unchanged) and the `typed` docs (routed through this module's
 * typed staging leg), resolving + reconstructing each typed doc against the loaded
 * profile. Path-prefix entity types win over `x-llmwiki.entityType`; an undeclared
 * declared type becomes an unknown-type fallback. Pure (no I/O).
 *
 * @param docs - The bundle's tolerantly-parsed OKF docs.
 * @param profile - The active NON-DEFAULT profile pack.
 * @param ctx - The bundle's map context (id + title resolver) for body reversal.
 * @param onWarn - Sink for mismatch / unknown-type warnings.
 * @returns The untyped `native` docs and the reconstructed `typed` docs.
 */
export function partitionProfileDocs(
  docs: RawOkfDoc[],
  profile: ProfilePack,
  ctx: OkfMapContext,
  onWarn: (msg: string) => void,
): { native: RawOkfDoc[]; typed: MappedTypedOkfDoc[] } {
  const keys = new Set(Object.keys(profile.entities));
  const native: RawOkfDoc[] = [];
  const typed: MappedTypedOkfDoc[] = [];
  for (const doc of docs) {
    const resolution = resolveEntityType(doc, keys, onWarn);
    if (resolution === null) native.push(doc);
    else typed.push(mapTypedDoc(doc, resolution, profile, ctx));
  }
  return { native, typed };
}

/** The `imported-okf` held reason imported OKF pages carry (mirrors the untyped `stageAll`). */
const IMPORTED_HELD: HeldReason = { code: "imported-okf" };

/** True for a staging error that routes to the untyped fallback rather than aborting the import (D-7.6.5). */
function isFallbackStagingError(error: unknown): boolean {
  return (
    error instanceof EntityFieldContractError ||
    error instanceof LifecycleTransitionError ||
    error instanceof BlockedStagedWriteError ||
    error instanceof UnknownEntityTypeError
  );
}

/** Stage a doc's UNTYPED concept form as the mismatch/unknown-type fallback (never goes live). */
async function stageMismatchFallback(
  root: string,
  doc: MappedTypedOkfDoc,
  reason: string,
): Promise<TypedImportOutcome> {
  const page = doc.untyped;
  await writeCandidate(root, {
    title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
    reviewMode: "imported", heldReasons: [{ code: "imported-okf", detail: `profile-mismatch: ${reason}` }],
    targetDirectory: "concepts", okfPath: page.okfPath,
  });
  return { okfPath: doc.okfPath, slug: page.slug, entityType: doc.entityType, outcome: "mismatch-fallback", reason };
}

/**
 * Promote a just-staged typed candidate LIVE via the lock-free {@link applyTypedCandidate}
 * (the import lock is already held). On a promotion refusal (a typed error at the
 * planner/validation stage) the candidate is RETAINED — fail to review, never fail
 * open — and the report says so.
 */
async function promoteStaged(root: string, doc: MappedTypedOkfDoc, candidateId: string): Promise<TypedImportOutcome> {
  const base = { okfPath: doc.okfPath, slug: doc.slug, entityType: doc.entityType };
  const candidate = await readCandidate(root, candidateId);
  if (!candidate) return { ...base, outcome: "staged-typed", reason: "candidate vanished before promotion" };
  try {
    await applyTypedCandidate(root, candidate);
    await deleteCandidate(root, candidateId);
    return { ...base, outcome: "promoted-typed" };
  } catch (error) {
    return { ...base, outcome: "staged-typed", reason: `promotion-refused: ${(error as Error).message}` };
  }
}

/** Stage one typed doc (and promote it when trusted), falling back to untyped staging on a typed error. */
async function applyOneTypedDoc(
  root: string,
  doc: MappedTypedOkfDoc,
  profile: ProfilePack,
  trusted: boolean,
): Promise<TypedImportOutcome> {
  if (doc.entityType === undefined || doc.typedBody === undefined) {
    return stageMismatchFallback(root, doc, doc.fallbackReason ?? "unknown entity type");
  }
  let candidateId: string;
  try {
    const staged = await stageEntityPage(root, {
      entityType: doc.entityType, slug: doc.slug, body: doc.typedBody, profile,
      existingStagedCount: 0, reviewMode: "imported", heldReasons: [IMPORTED_HELD],
    });
    candidateId = staged.id;
  } catch (error) {
    if (isFallbackStagingError(error)) return stageMismatchFallback(root, doc, (error as Error).message);
    throw error;
  }
  if (!trusted) return { okfPath: doc.okfPath, slug: doc.slug, entityType: doc.entityType, outcome: "staged-typed" };
  return promoteStaged(root, doc, candidateId);
}

/**
 * Stage (and, when `trusted`, promote) every typed doc, returning one outcome per
 * doc. The caller MUST already hold the project lock (staging + the lock-free
 * {@link applyTypedCandidate} run under it). A typed doc NEVER goes live through the
 * legacy `writeAll`: it either lands via the planner (`promoted-typed`), stays a
 * typed review candidate (`staged-typed`), or falls back to untyped staging
 * (`mismatch-fallback`).
 *
 * @param root - Absolute project root directory.
 * @param typed - The collision-filtered typed docs to apply.
 * @param profile - The active NON-DEFAULT profile pack.
 * @param trusted - Whether to additionally promote each staged typed candidate live.
 * @returns One {@link TypedImportOutcome} per doc.
 */
export async function applyTypedDocs(
  root: string,
  typed: MappedTypedOkfDoc[],
  profile: ProfilePack,
  trusted: boolean,
): Promise<TypedImportOutcome[]> {
  const outcomes: TypedImportOutcome[] = [];
  for (const doc of typed) outcomes.push(await applyOneTypedDoc(root, doc, profile, trusted));
  return outcomes;
}

/** Project the typed docs to their prospective outcomes for a dry-run (no I/O, nothing staged). */
export function previewTypedOutcomes(typed: MappedTypedOkfDoc[]): TypedImportOutcome[] {
  return typed.map((doc) =>
    doc.entityType === undefined
      ? { okfPath: doc.okfPath, slug: doc.slug, outcome: "mismatch-fallback", reason: doc.fallbackReason ?? "unknown entity type" }
      : { okfPath: doc.okfPath, slug: doc.slug, entityType: doc.entityType, outcome: "staged-typed" },
  );
}
