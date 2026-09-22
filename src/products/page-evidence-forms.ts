/**
 * @file src/products/page-evidence-forms.ts
 * @description The four page-evidence capture FORMS (P5c §2a): host-derived
 * reads that seal digest + byte count (and small scalar values) under each
 * capture's own slug-safe key namespace. The orchestrating capture
 * (`page-evidence-capture.ts`) resolves the target page and calls one helper
 * per declared capture; NOTHING here reads caller input except the declared
 * slug/runId fields the grammar names.
 *
 * SEAL REFERENCES AND HASHES, NEVER RAW BUFFERS: scalar page fields seal
 * their value (they are bounded); artifact bodies and run outputs seal only
 * digest + byte count — the runtime re-reads the bytes from their stores and
 * re-verifies against the seal before the provider sees them.
 */

import { createHash } from "node:crypto";
import { parseArtifactRef } from "../artifacts/ref.js";
import { resolveArtifactRef } from "../artifacts/resolve.js";
import { artifactPaths, hashArtifactBody, readArtifactBody } from "../artifacts/store.js";
import { readLiveValidRelations } from "../relations/live-valid.js";
import { readConfinedEntityFrontmatter } from "../profile/lifecycle-read.js";
import { locatePreparationManifest, readPreparationInitialInput, resolvePreparationRun } from "../preparations/service-run-lookup.js";
import type { LoadedProfile } from "../profile/types.js";
import type {
  ArtifactDerefCaptureV2, PageFieldCaptureV2, RelationTargetCaptureV2, RunBindingCaptureV2,
} from "../operations-packs/recipe-types.js";

/** One form's outcome: the sealed key/value pairs, or a named refusal. */
export type FormCaptureV1 =
  | { readonly seal: Readonly<Record<string, string>> }
  | { readonly refused: string };

/** sha256 of a utf8 string, bare hex. */
function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Seal a bounded scalar under `<captureId>-value/-sha256/-byte-count`. */
function sealScalar(captureId: string, value: string): Record<string, string> {
  return {
    [`${captureId}-value`]: value,
    [`${captureId}-sha256`]: sha256Utf8(value),
    [`${captureId}-byte-count`]: String(Buffer.byteLength(value, "utf8")),
  };
}

/** Capture one profile-declared scalar field from already-read frontmatter. */
export function capturePageField(
  meta: Readonly<Record<string, unknown>>, capture: PageFieldCaptureV2, pageLabel: string,
  declaredFields?: Readonly<Record<string, unknown>>,
): FormCaptureV1 {
  // PROFILE-DECLARED ONLY (M4r-code1): frontmatter admits extra keys, so an
  // undeclared field would let arbitrary page content masquerade as sealed
  // evidence. The declared-field set comes from the target's entity type.
  // FAIL CLOSED (P1r3): an entity with NO declared fields map can declare
  // nothing — extra frontmatter is legal there, so treating "no map" as
  // "anything goes" would admit attacker content as sealed evidence.
  // Object.hasOwn, not property lookup (the accessor/prototype trap): a
  // descriptor naming `constructor` must not resolve through the prototype.
  if (declaredFields === undefined || !Object.hasOwn(declaredFields, capture.field)) {
    return { refused: `capture ${capture.captureId}: ${JSON.stringify(capture.field)} is not a declared field of the target entity type` };
  }
  const value = meta[capture.field];
  if (typeof value !== "string" || value.length === 0) {
    return { refused: `${pageLabel} carries no scalar ${JSON.stringify(capture.field)} for capture ${capture.captureId}` };
  }
  if (Buffer.byteLength(value, "utf8") > capture.maxBytes) {
    return { refused: `capture ${capture.captureId}: field ${capture.field} exceeds its sealed ${capture.maxBytes}-byte cap` };
  }
  return { seal: sealScalar(capture.captureId, value) };
}

/**
 * Dereference a hash-pinned SINGLE-BODY artifact named by a page field: the
 * ref must parse in full canonical form, name the declared type, resolve
 * healthy, and the body must REHASH to the pinned digest at capture time.
 */
export async function captureArtifactDeref(
  root: string, loaded: LoadedProfile, meta: Readonly<Record<string, unknown>>,
  capture: ArtifactDerefCaptureV2, pageLabel: string,
  declaredFields?: Readonly<Record<string, unknown>>,
): Promise<FormCaptureV1> {
  // The REF FIELD must be profile-declared too (P1c-r2), and an entity with
  // NO fields map fails closed (P1r3) — an undeclared frontmatter key
  // pointing at a healthy artifact is still attacker input.
  if (declaredFields === undefined || !Object.hasOwn(declaredFields, capture.refField)) {
    return { refused: `capture ${capture.captureId}: ${JSON.stringify(capture.refField)} is not a declared field of the target entity type` };
  }
  const raw = meta[capture.refField];
  const ref = parseArtifactRef(raw);
  if (ref === null) return { refused: `${pageLabel} carries no pinned ref under ${JSON.stringify(capture.refField)}` };
  if (ref.artifactType !== capture.artifactType) {
    return { refused: `capture ${capture.captureId}: ref names ${ref.artifactType}, the descriptor seals ${capture.artifactType}` };
  }
  const def = loaded.profile.artifacts?.[ref.artifactType];
  if (def === undefined || def.members !== undefined) {
    return { refused: `capture ${capture.captureId}: ${ref.artifactType} is not a declared single-body artifact type` };
  }
  const resolution = await resolveArtifactRef(root, loaded.profile, ref);
  if (resolution.health !== "ok") return { refused: `capture ${capture.captureId}: the pinned artifact is ${resolution.health}` };
  const body = await readArtifactBody(root, artifactPaths(root, ref.artifactType, ref.slug, def.fileName), capture.maxBytes);
  if (body.kind !== "ok") return { refused: `capture ${capture.captureId}: the artifact body is ${body.kind}` };
  if (hashArtifactBody(body.body) !== ref.sha256) {
    return { refused: `capture ${capture.captureId}: the artifact was rewritten during capture; retry` };
  }
  return {
    seal: {
      [`${capture.captureId}-ref`]: `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
      [`${capture.captureId}-sha256`]: ref.sha256,
      [`${capture.captureId}-byte-count`]: String(Buffer.byteLength(body.body, "utf8")),
    },
  };
}

/**
 * Traverse EXACTLY ONE outgoing declared relation from the target page, then
 * capture fields on the resolved target. Zero or many edges refuse — a judge
 * must never guess which proposition it is judging.
 */
export async function captureRelationTarget(
  root: string, loaded: LoadedProfile, fromPageId: string, capture: RelationTargetCaptureV2,
): Promise<FormCaptureV1> {
  const relations = await readLiveValidRelations(root, loaded.profile);
  const targets = relations
    .filter((relation) => relation.type === capture.relationType && relation.from === fromPageId
      && relation.to.startsWith(`${capture.targetEntityType}/`))
    .map((relation) => relation.to);
  if (targets.length !== 1) {
    return { refused: `capture ${capture.captureId}: ${fromPageId} has ${targets.length} outgoing ${capture.relationType} edges to ${capture.targetEntityType}; exactly one is required` };
  }
  const targetId = targets[0]!;
  const slug = targetId.slice(capture.targetEntityType.length + 1);
  const def = loaded.profile.entities[capture.targetEntityType];
  if (def === undefined) return { refused: `capture ${capture.captureId}: entity type ${capture.targetEntityType} is not declared` };
  const read = await readConfinedEntityFrontmatter(root, def, slug);
  if (read.kind !== "frontmatter") {
    return { refused: `capture ${capture.captureId}: relation target ${targetId} is ${read.kind}` };
  }
  let seal: Record<string, string> = { [`${capture.captureId}-target`]: targetId };
  for (const then of capture.then) {
    const inner = capturePageField(read.meta, then, `relation target ${targetId}`, def.fields as Readonly<Record<string, unknown>> | undefined);
    if ("refused" in inner) return inner;
    seal = { ...seal, ...inner.seal };
  }
  return { seal };
}

/**
 * Authenticate one preparation run and capture its frozen fields and selected
 * outputs. The run must belong to the EXACT expected action, be in the
 * expected state, and its sealed slug field must equal the descriptor
 * target's slug — a foreign or unfinished run never feeds a judge.
 */
export async function captureRunBinding(
  root: string, capture: RunBindingCaptureV2, runId: string, targetSlug: string,
): Promise<FormCaptureV1> {
  const located = await locatePreparationManifest(root, runId);
  if (!located.ok) return { refused: `capture ${capture.captureId}: run ${runId} could not be located: ${located.reason}` };
  if (located.manifest.plan.actionAuthority.actionId !== capture.expect.actionId) {
    return { refused: `capture ${capture.captureId}: run ${runId} is not a ${capture.expect.actionId} run` };
  }
  const sealed = await readPreparationInitialInput(root, located.manifest);
  if (!sealed.ok) return { refused: `capture ${capture.captureId}: run ${runId}: ${sealed.reason}` };
  if (sealed.record[capture.expect.slugField] !== targetSlug) {
    return { refused: `capture ${capture.captureId}: run ${runId} was sealed for "${String(sealed.record[capture.expect.slugField])}", not "${targetSlug}"` };
  }
  const resolved = await resolvePreparationRun(root, runId);
  if (!resolved.ok) return { refused: `capture ${capture.captureId}: run ${runId} could not be read: ${resolved.reason}` };
  if (resolved.run.state !== capture.expect.state) {
    return { refused: `capture ${capture.captureId}: run ${runId} is ${resolved.run.state}; ${capture.expect.state} is required` };
  }
  return sealRunParts(capture, runId, sealed.record, resolved.run);
}

/** Seal ONE frozen scalar field out of the authenticated run's sealed input. */
function sealFrozenField(
  field: RunBindingCaptureV2["frozenFields"][number], frozen: Readonly<Record<string, unknown>>,
): FormCaptureV1 {
  const value = frozen[field.field];
  if (typeof value !== "string" || value.length === 0) {
    return { refused: `capture ${field.captureId}: the run seals no scalar ${JSON.stringify(field.field)}` };
  }
  if (Buffer.byteLength(value, "utf8") > field.maxBytes) {
    return { refused: `capture ${field.captureId}: frozen ${field.field} exceeds its sealed ${field.maxBytes}-byte cap` };
  }
  return { seal: sealScalar(field.captureId, value) };
}

/** Seal the frozen fields and each selected output's digest + byte count. */
function sealRunParts(
  capture: RunBindingCaptureV2, runId: string, frozen: Readonly<Record<string, unknown>>,
  run: { phaseSummaries: readonly { logicalPhaseId: string; state: string; currentAttemptId?: string; outputEvidenceDigest?: string }[]; evidenceRefs: readonly { kind: string; provenanceLabel: string; digest: string; byteCount: number; producer: { kind: string; attemptId?: string } }[] },
): FormCaptureV1 {
  let seal: Record<string, string> = { [`${capture.captureId}-run`]: runId };
  for (const field of capture.frozenFields) {
    const sealed = sealFrozenField(field, frozen);
    if ("refused" in sealed) return sealed;
    seal = { ...seal, ...sealed.seal };
  }
  for (const output of capture.outputs) {
    const sealed = sealRunOutput(output, run);
    if ("refused" in sealed) return sealed;
    seal = { ...seal, ...sealed.seal };
  }
  return { seal };
}

/**
 * The evidence refs congruently matching one phase's output (D94: identical
 * refs are one object twice — congruent; producer narrowing only on
 * disagreement). Empty means missing OR irreconcilably incongruent.
 */
function congruentOutputRefs(
  output: RunBindingCaptureV2["outputs"][number],
  summary: { outputEvidenceDigest?: string; currentAttemptId?: string },
  refs: Parameters<typeof sealRunParts>[3]["evidenceRefs"],
): Parameters<typeof sealRunParts>[3]["evidenceRefs"] {
  // The producer/current-attempt bind is UNCONDITIONAL (M7r-code1): a stale
  // attempt's same-label output with coincidentally identical metadata must
  // never stand in for the current attempt's. Congruent multiples of the
  // CURRENT attempt remain accepted (D94).
  const matches = refs.filter((ref) => ref.digest === summary.outputEvidenceDigest
    && ref.kind === output.refKind && ref.provenanceLabel === output.refProvenanceLabel
    && ref.producer.kind === "provider" && ref.producer.attemptId === summary.currentAttemptId);
  const congruent = new Set(matches.map((ref) => ref.byteCount)).size === 1;
  return matches.length > 0 && congruent ? matches : [];
}

/**
 * Seal ONE selected run output under the congruent-multiples rule (the D94
 * lesson: identical refs are one object twice — congruent, never ambiguous;
 * producer narrowing applies only when matches DISAGREE).
 */
function sealRunOutput(
  output: RunBindingCaptureV2["outputs"][number],
  run: Parameters<typeof sealRunParts>[3],
): FormCaptureV1 {
  const summaries = run.phaseSummaries.filter((phase) => phase.logicalPhaseId === output.logicalPhaseId);
  if (summaries.length !== 1 || summaries[0]!.state !== "succeeded" || summaries[0]!.outputEvidenceDigest === undefined) {
    return { refused: `capture ${output.captureId}: the run has no unique succeeded ${output.logicalPhaseId} phase with output evidence` };
  }
  const summary = summaries[0]!;
  const matches = congruentOutputRefs(output, summary, run.evidenceRefs);
  if (matches.length === 0) {
    const candidates = run.evidenceRefs.filter((ref) => ref.digest === summary.outputEvidenceDigest)
      .map((ref) => `${ref.kind}/${ref.provenanceLabel}`).join(", ") || "none";
    return { refused: `capture ${output.captureId}: no congruent evidence ref matches phase ${output.logicalPhaseId}'s output digest (declared ${output.refKind}/${output.refProvenanceLabel}; present: ${candidates})` };
  }
  if (matches[0]!.byteCount > output.maxBytes) {
    return { refused: `capture ${output.captureId}: the output's ${matches[0]!.byteCount} bytes exceed the sealed ${output.maxBytes}-byte cap` };
  }
  return { seal: {
    [`${output.captureId}-sha256`]: String(summary.outputEvidenceDigest).replace(/^sha256:/, ""),
    [`${output.captureId}-byte-count`]: String(matches[0]!.byteCount),
  } };
}
