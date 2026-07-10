/**
 * @file src/profile/artifact-lint.ts
 * @description Additive artifact-ref HEALTH findings, the read-surface mirror of
 * `relation-lint.ts`: every hash-pinned artifactRef value under a page's
 * declared fields OR a live relation's declared attributes is resolved against
 * the ACTUAL bytes (via `resolveArtifactRef`, the bytes-verified reader in
 * `../artifacts/resolve.js`), and a non-`ok` health becomes a finding.
 *
 * Severity mirrors the relation-lint park/deny split: `artifact-unreadable` (a
 * transient read fault — cannot verify, not a confirmed violation) is a
 * `warning`; every other non-ok health (dangling / bytes-tampered /
 * hash-mismatch / schema-invalid / store-unavailable) is an `error`.
 *
 * `checkArtifactRefs` is the ONE resolution pass, reused by every read surface:
 *   - `lint.ts` consumes the `LintResult[]` directly;
 *   - `block.ts` (status/viewer) and `export/profile-block.ts` (export) consume
 *     the path-safe `EntityProblemView[]` from {@link artifactProblemViews}, a
 *     thin mapper over the SAME findings, and fold them into
 *     `snapshot.profile.problems`;
 *   - `context/pack-warnings.ts`'s `appendArtifactWarning` filters that SAME
 *     `snapshot.profile.problems` list for `kind === "artifact-store"` to
 *     surface a top-level `artifact-ref-unhealthy` warning — so all four
 *     surfaces can never disagree about which refs are unhealthy.
 *
 * `checkArtifactRefs` ALSO runs a second, PURE detective pass
 * ({@link checkGatedPageRequirements}): for a LIVE page CURRENTLY in a lifecycle
 * state that declares `transitionArtifactRequirements`, it flags each required
 * `{field, artifactType}` the page does NOT satisfy — the required field absent /
 * unparseable, or a ref pinning the WRONG artifact type. This is the read-side
 * backstop behind the write-time enforcer (`../artifacts/enforce-precondition.ts`):
 * it catches a profile that adds a requirement AFTER pages went live, and any
 * future write-path miss. A present ref of the RIGHT type emits nothing from this
 * pass — its bytes-health is already covered by the per-field health pass above, so
 * the two never double-report.
 *
 * A profile with no `artifacts` block declares no possible refs (and no
 * enforceable precondition), so this returns immediately — the
 * default/artifact-less profile's read surfaces stay byte-identical.
 */
import path from "path";
import { scanEntityDir } from "../wiki/collect.js";
import { safeRealpath } from "../utils/path-confine.js";
import { parseArtifactRef, formatArtifactRef, type ArtifactRef } from "../artifacts/ref.js";
import { resolveArtifactRef, type ArtifactHealth } from "../artifacts/resolve.js";
import { refValuesFor } from "./artifact-ref-validate.js";
import { readLiveValidRelations } from "../relations/live-valid.js";
import type { ArtifactPreconditionReq, ProfilePack, EntityProblemView } from "./types.js";
import type { RelationRef } from "../relations/types.js";
import type { LintResult } from "../linter/types.js";

/** The minimal page shape `checkArtifactRefs` needs — an `EntityPage` satisfies it structurally. */
export interface ArtifactRefPageSource {
  entityType: string;
  filePath: string;
  frontmatter: Record<string, unknown>;
}

/** The `file` label for relation-attribute artifact findings (store-level, not page-scoped). */
const RELATION_STORE_FILE = "wiki/graph/relations.jsonl";

/** Human-readable phrase for each non-ok health, folded into a finding's message. */
const HEALTH_PHRASE: Record<Exclude<ArtifactHealth, "ok">, string> = {
  "artifact-dangling": "the artifact does not exist",
  "artifact-unreadable": "the artifact could not be read",
  "artifact-bytes-tampered": "the artifact bytes no longer match its own manifest",
  "artifact-hash-mismatch": "the artifact bytes no longer match the ref's pinned hash",
  "artifact-schema-invalid": "the artifact body no longer satisfies its declared schema",
  "artifact-store-unavailable": "the artifact manifest is malformed or inconsistent",
};

/** Build a finding for a non-`ok` health, or `null` (no finding) for `ok`. */
function healthFinding(health: ArtifactHealth, file: string, subject: string, ref: ArtifactRef, entityType?: string): LintResult | null {
  if (health === "ok") return null;
  return {
    rule: health,
    severity: health === "artifact-unreadable" ? "warning" : "error",
    file,
    message: `${subject} references ${formatArtifactRef(ref)} (${health}): ${HEALTH_PHRASE[health]}`,
    ...(entityType ? { entityType } : {}),
  };
}

/** Resolve and flag every artifactRef value under one page's declared fields. */
async function checkPageArtifactRefs(root: string, page: ArtifactRefPageSource, profile: ProfilePack): Promise<LintResult[]> {
  const def = profile.entities[page.entityType];
  if (!def) return [];
  const findings: LintResult[] = [];
  for (const occ of refValuesFor(def.fields ?? {}, page.frontmatter)) {
    const ref = parseArtifactRef(occ.raw);
    if (!ref) continue; // a structural failure is Layer A's job, not health resolution
    const { health } = await resolveArtifactRef(root, profile, ref);
    const finding = healthFinding(health, page.filePath, `field ${JSON.stringify(occ.field)}`, ref, page.entityType);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** Resolve and flag every artifactRef value under every live relation's declared attributes. */
async function checkRelationArtifactRefs(root: string, profile: ProfilePack): Promise<LintResult[]> {
  if (!profile.relations) return [];
  let relations: RelationRef[];
  try {
    relations = await readLiveValidRelations(root, profile);
  } catch {
    return []; // the relation store's own health is already surfaced by checkRelationStore
  }
  const findings: LintResult[] = [];
  for (const rel of relations) {
    const attrDefs = profile.relations[rel.type]?.attributes;
    if (!attrDefs) continue;
    for (const occ of refValuesFor(attrDefs, rel.attributes)) {
      const ref = parseArtifactRef(occ.raw);
      if (!ref) continue;
      const { health } = await resolveArtifactRef(root, profile, ref);
      const subject = `relation ${rel.id} (${rel.type}) attribute ${JSON.stringify(occ.field)}`;
      const finding = healthFinding(health, RELATION_STORE_FILE, subject, ref);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

/** Rule id for a live gated page missing a required artifact ref entirely. */
const REQUIRED_ARTIFACT_MISSING_RULE = "gated-page-required-artifact-missing";
/** Rule id for a live gated page whose required-field ref pins the WRONG artifact type. */
const REQUIRED_ARTIFACT_WRONG_TYPE_RULE = "gated-page-required-artifact-wrong-type";

/** Build the `error` finding for a required artifact field that is absent/unparseable on a live gated page. */
function missingRequirementFinding(page: ArtifactRefPageSource, state: string, req: ArtifactPreconditionReq): LintResult {
  return {
    rule: REQUIRED_ARTIFACT_MISSING_RULE,
    severity: "error",
    file: page.filePath,
    message: `field ${JSON.stringify(req.field)} required by lifecycle state ${JSON.stringify(state)} carries no resolvable ${req.artifactType} artifact ref`,
    entityType: page.entityType,
  };
}

/** Build the `error` finding for a required artifact field whose ref pins a different artifact type than required. */
function wrongTypeRequirementFinding(page: ArtifactRefPageSource, state: string, req: ArtifactPreconditionReq, ref: ArtifactRef): LintResult {
  return {
    rule: REQUIRED_ARTIFACT_WRONG_TYPE_RULE,
    severity: "error",
    file: page.filePath,
    message: `field ${JSON.stringify(req.field)} required by lifecycle state ${JSON.stringify(state)} pins a ${ref.artifactType} artifact but a ${req.artifactType} is required`,
    entityType: page.entityType,
  };
}

/** The lifecycle state a page CURRENTLY sits in plus its per-state artifact requirements, or `null` when the page is not gated (no lifecycle value, or a state declaring none) — mirrors the write path's `enteredLifecycleState` guard. */
function gatedArtifactRequirements(page: ArtifactRefPageSource, profile: ProfilePack): { state: string; reqs: ArtifactPreconditionReq[] } | null {
  const lifecycle = profile.entities[page.entityType]?.lifecycle;
  const state = lifecycle ? page.frontmatter[lifecycle.field] : undefined;
  if (typeof state !== "string") return null;
  const reqs = lifecycle!.transitionArtifactRequirements?.[state];
  return reqs !== undefined && reqs.length > 0 ? { state, reqs } : null;
}

/** Classify ONE required `{field, artifactType}` on a gated page: a `missing`/`wrong-type` finding, or `null` when it is satisfied (a present ref of the RIGHT type — its bytes-health is {@link checkPageArtifactRefs}'s job, never double-reported here). */
function unmetRequirementFinding(page: ArtifactRefPageSource, state: string, req: ArtifactPreconditionReq): LintResult | null {
  const ref = parseArtifactRef(page.frontmatter[req.field]);
  if (!ref) return missingRequirementFinding(page, state, req);
  if (ref.artifactType !== req.artifactType) return wrongTypeRequirementFinding(page, state, req, ref);
  return null;
}

/**
 * Detective read-side check: for a LIVE page whose CURRENT lifecycle-field value is a
 * state declaring `transitionArtifactRequirements`, flag each required `{field,
 * artifactType}` the page does NOT satisfy — the field absent/unparseable
 * (`gated-page-required-artifact-missing`) or a ref of the WRONG type
 * (`gated-page-required-artifact-wrong-type`). A present ref of the RIGHT type emits
 * NOTHING here (see {@link unmetRequirementFinding}). PURE + synchronous — mirrors the
 * write enforcer's parse-then-type-bind (`../artifacts/enforce-precondition.ts`)
 * WITHOUT resolving bytes. A non-gated page contributes nothing.
 */
function checkGatedPageRequirements(page: ArtifactRefPageSource, profile: ProfilePack): LintResult[] {
  const gated = gatedArtifactRequirements(page, profile);
  if (!gated) return [];
  const findings: LintResult[] = [];
  for (const req of gated.reqs) {
    const finding = unmetRequirementFinding(page, gated.state, req);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * Resolve every artifactRef value reachable from `pages`' declared fields AND
 * the live relation store's declared attributes, flagging each non-`ok` health
 * as a `LintResult` (mirrors {@link checkRelationStore} in `relation-lint.ts`).
 *
 * @param root - Absolute project root directory.
 * @param pages - The profile's collected entity pages (or any structurally
 *   compatible frontmatter-only source — see {@link collectArtifactRefPageSources}).
 * @param profile - The CURRENT profile pack (its `artifacts`/`entities`/`relations`
 *   blocks are the schema every ref is resolved and scoped against).
 * @returns All artifact-ref health findings (possibly empty).
 */
export async function checkArtifactRefs(
  root: string,
  pages: ArtifactRefPageSource[],
  profile: ProfilePack,
): Promise<LintResult[]> {
  if (!profile.artifacts || Object.keys(profile.artifacts).length === 0) return [];
  const findings: LintResult[] = [];
  for (const page of pages) {
    findings.push(...(await checkPageArtifactRefs(root, page, profile)));
    findings.push(...checkGatedPageRequirements(page, profile));
  }
  findings.push(...(await checkRelationArtifactRefs(root, profile)));
  return findings;
}

/**
 * Frontmatter-only entity-page scan (no bodies), for callers that need
 * artifact-ref health WITHOUT already holding content-carrying `EntityPage`s —
 * e.g. `collectProfileSummary`, which otherwise only tallies counts. Mirrors
 * `block.ts`'s `tallyLifecycleStates` scan shape.
 *
 * @param root - Absolute project root directory.
 * @param profile - The profile pack whose declared entity directories are scanned.
 * @returns One {@link ArtifactRefPageSource} per readable page (an invalid or
 *   missing directory is silently skipped — already surfaced by the entity collector).
 */
export async function collectArtifactRefPageSources(root: string, profile: ProfilePack): Promise<ArtifactRefPageSource[]> {
  const sources: ArtifactRefPageSource[] = [];
  for (const [entityType, def] of Object.entries(profile.entities)) {
    const { scans, dirStatus } = await scanEntityDir(root, def.directory, { includeBody: false });
    if (dirStatus !== "ok") continue;
    for (const scan of scans) sources.push({ entityType, filePath: scan.filePath, frontmatter: scan.frontmatter });
  }
  return sources;
}

/** Relativize a `LintResult.file` against `root` when it is an absolute page path; an already-relative store-level label passes through unchanged. */
function relativizeFile(file: string, canonicalRoot: string): string {
  return path.isAbsolute(file) ? path.relative(canonicalRoot, file) : file;
}

/**
 * The path-safe {@link EntityProblemView} mirror of {@link checkArtifactRefs},
 * for the additive status/viewer/context/export surfaces (never the absolute
 * `LintResult.file` the CLI-facing lint output carries).
 *
 * @param root - Absolute project root directory.
 * @param pages - Same as {@link checkArtifactRefs}.
 * @param profile - Same as {@link checkArtifactRefs}.
 * @returns The SAME findings as {@link checkArtifactRefs}, reshaped path-safe.
 */
export async function artifactProblemViews(
  root: string,
  pages: ArtifactRefPageSource[],
  profile: ProfilePack,
): Promise<EntityProblemView[]> {
  const results = await checkArtifactRefs(root, pages, profile);
  if (results.length === 0) return [];
  const canonicalRoot = (await safeRealpath(root)) ?? root;
  return results.map((r) => ({
    kind: "artifact-store" as const,
    ...(r.entityType ? { entityType: r.entityType } : {}),
    path: relativizeFile(r.file, canonicalRoot),
    message: r.message,
  }));
}
