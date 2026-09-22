/**
 * @file src/operations-packs/runtime/page-evidence.ts
 * @description Build the provider input specs a sealed PAGE-EVIDENCE
 * descriptor names (P5c §2a) — ONE function, TWO consumers, exactly like its
 * source/artifact-evidence siblings: the authority resolver computes the
 * exposure digest over these specs at seal and at leg revalidation; the leg
 * builder materializes the same specs into the provider's confined input
 * region.
 *
 * NOTHING SEALED IS TRUSTED, EVERYTHING SEALED IS RE-VERIFIED. Runtime
 * re-verification RE-RUNS the capture forms against the live page, relation
 * graph, artifact store, and run store, and requires every re-derived sealed
 * key to EQUAL the frozen input byte for byte — a drifted page field, a
 * rewritten artifact, a re-pointed relation, or a vanished run REFUSES with a
 * named reason; the provider is never fed values under seals they no longer
 * satisfy. The bytes then materialized are the freshly re-verified reads.
 */

import { createHash } from "node:crypto";
import { loadNonDefaultProfile } from "../../profile/block.js";
import { readConfinedEntityFrontmatter } from "../../profile/lifecycle-read.js";
import {
  captureArtifactDeref, capturePageField, captureRelationTarget, captureRunBinding,
  type FormCaptureV1,
} from "../../products/page-evidence-forms.js";
import { parseArtifactRef } from "../../artifacts/ref.js";
import { artifactPaths, readArtifactBody } from "../../artifacts/store.js";
import { locatePreparationManifest, resolvePreparationRun } from "../../preparations/service-run-lookup.js";
import { readPreparationEvidenceBytes } from "../../preparations/evidence-store.js";
import type { PlanPageEvidenceDescriptorV1 } from "../../preparations/plan-types.js";
import type { PageEvidenceCaptureV2, PageEvidenceExposureV2 } from "../recipe-types.js";
import type { ProviderInputSpecV1 } from "../../capability-providers/runtime/inputs.js";
import type { SourceEvidenceSpecsV1 } from "./source-evidence.js";
import type { LoadedProfile } from "../../profile/types.js";

/** A failure names WHICH leg refused; "couldn't verify" is never "doesn't exist". */
export type PageEvidenceOutcomeV1 =
  | { readonly status: "ok"; readonly built: SourceEvidenceSpecsV1 }
  | { readonly status: "unavailable"; readonly reason: string };

/** Dispatch ONE capture re-run against the live sources (form-selected). */
async function rerunCapture(
  root: string, loaded: LoadedProfile, descriptor: PlanPageEvidenceDescriptorV1,
  capture: PageEvidenceCaptureV2, meta: Readonly<Record<string, unknown>>, slug: string,
  frozen: Readonly<Record<string, unknown>>,
): Promise<FormCaptureV1> {
  const pageLabel = `${descriptor.target.entityType}/${slug}`;
  const fields = loaded.profile.entities[descriptor.target.entityType]?.fields as
    Readonly<Record<string, unknown>> | undefined;
  if (capture.form === "page-field") return capturePageField(meta, capture, pageLabel, fields);
  if (capture.form === "artifact-deref") return captureArtifactDeref(root, loaded, meta, capture, pageLabel, fields);
  if (capture.form === "relation-target") return captureRelationTarget(root, loaded, pageLabel, capture);
  const runId = frozen[`${capture.captureId}-run`];
  if (typeof runId !== "string") return { refused: `page-evidence-${capture.captureId}-run-unsealed` };
  return captureRunBinding(root, capture, runId, slug);
}

/** Re-run one capture form and refuse unless every sealed key matches frozen. */
async function reverifiedSeal(
  root: string, loaded: LoadedProfile, descriptor: PlanPageEvidenceDescriptorV1,
  capture: PageEvidenceCaptureV2, meta: Readonly<Record<string, unknown>>, slug: string,
  frozen: Readonly<Record<string, unknown>>,
): Promise<{ seal: Readonly<Record<string, string>> } | { reason: string }> {
  const outcome = await rerunCapture(root, loaded, descriptor, capture, meta, slug, frozen);
  if ("refused" in outcome) return { reason: `page-evidence-reverify: ${outcome.refused}` };
  for (const [key, value] of Object.entries(outcome.seal)) {
    if (frozen[key] !== value) return { reason: `page-evidence-drift: ${key} no longer matches its seal` };
  }
  return { seal: outcome.seal };
}

/** Materialize one scalar capture's bytes from its re-verified sealed value. */
function scalarSpec(exposure: PageEvidenceExposureV2, captureId: string, seal: Readonly<Record<string, string>>): ProviderInputSpecV1 {
  return {
    inputId: exposure.inputId, kind: exposure.kind, provenanceLabel: exposure.provenanceLabel,
    mediaType: exposure.mediaType, bytes: Buffer.from(seal[`${captureId}-value`] ?? "", "utf8"),
  };
}

/** Materialize an artifact-deref capture by re-reading its verified body. */
async function artifactSpec(
  root: string, loaded: LoadedProfile,
  capture: Extract<PageEvidenceCaptureV2, { form: "artifact-deref" }>,
  seal: Readonly<Record<string, string>>,
): Promise<ProviderInputSpecV1 | { reason: string }> {
  const ref = parseArtifactRef(seal[`${capture.captureId}-ref`]);
  if (ref === null) return { reason: `page-evidence-${capture.captureId}-ref-unparseable` };
  const def = loaded.profile.artifacts?.[ref.artifactType];
  if (def === undefined) return { reason: `page-evidence-${capture.captureId}-type-undeclared` };
  const body = await readArtifactBody(root, artifactPaths(root, ref.artifactType, ref.slug, def.fileName), capture.maxBytes);
  if (body.kind !== "ok") return { reason: `page-evidence-${capture.captureId}-body-${body.kind}` };
  const digest = createHash("sha256").update(body.body, "utf8").digest("hex");
  if (digest !== seal[`${capture.captureId}-sha256`]) return { reason: `page-evidence-${capture.captureId}-digest-drift` };
  return {
    inputId: capture.inputId, kind: capture.kind, provenanceLabel: capture.provenanceLabel,
    mediaType: capture.mediaType, bytes: Buffer.from(body.body, "utf8"),
  };
}

/** Materialize a run output by reading its evidence bytes under the seal. */
async function runOutputSpec(
  root: string, runId: string,
  output: PageEvidenceExposureV2 & { captureId: string; logicalPhaseId: string },
  seal: Readonly<Record<string, string>>,
): Promise<ProviderInputSpecV1 | { reason: string }> {
  const located = await locatePreparationManifest(root, runId);
  if (!located.ok) return { reason: `page-evidence-${output.captureId}-run-missing` };
  const digest = seal[`${output.captureId}-sha256`];
  const byteCount = Number(seal[`${output.captureId}-byte-count`]);
  if (digest === undefined || !Number.isFinite(byteCount)) return { reason: `page-evidence-${output.captureId}-seal-incomplete` };
  const read = await readPreparationEvidenceBytes(root, located.manifest, digest, output.maxBytes);
  if (read.status !== "ok") return { reason: `page-evidence-${output.captureId}-evidence-${read.status}` };
  if (read.bytes.byteLength !== byteCount) return { reason: `page-evidence-${output.captureId}-bytecount-drift` };
  return {
    inputId: output.inputId, kind: output.kind, provenanceLabel: output.provenanceLabel,
    mediaType: output.mediaType, bytes: read.bytes,
  };
}

/** Push one capture's specs (post-verification) onto the outputs. */
async function materializeCapture(
  root: string, loaded: LoadedProfile, capture: PageEvidenceCaptureV2,
  seal: Readonly<Record<string, string>>, specs: ProviderInputSpecV1[],
  pathTable: Record<string, string>,
): Promise<{ reason: string } | null> {
  const add = (spec: ProviderInputSpecV1, captureId: string): void => {
    specs.push(spec);
    pathTable[spec.inputId] = captureId;
  };
  if (capture.form === "page-field") add(scalarSpec(capture, capture.captureId, seal), capture.captureId);
  else if (capture.form === "artifact-deref") {
    const spec = await artifactSpec(root, loaded, capture, seal);
    if ("reason" in spec) return spec;
    add(spec, capture.captureId);
  } else if (capture.form === "relation-target") {
    for (const then of capture.then) add(scalarSpec(then, then.captureId, seal), then.captureId);
  } else {
    for (const field of capture.frozenFields) add(scalarSpec(field, field.captureId, seal), field.captureId);
    for (const output of capture.outputs) {
      const spec = await runOutputSpec(root, String(seal[`${capture.captureId}-run`]), output, seal);
      if ("reason" in spec) return spec;
      add(spec, output.captureId);
    }
  }
  return null;
}

/**
 * Build the provider input specs one sealed page-evidence descriptor names,
 * re-verifying every sealed source first (drift refuses).
 *
 * @param root - Absolute project root.
 * @param descriptor - The sealed plan descriptor.
 * @param value - The run's frozen initial input (the sealed keys live here).
 */
export async function buildPageEvidenceSpecs(
  root: string, descriptor: PlanPageEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): Promise<PageEvidenceOutcomeV1> {
  const slug = value[descriptor.target.slugField];
  if (typeof slug !== "string" || slug.length === 0) return { status: "unavailable", reason: "page-evidence-slug-unsealed" };
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { status: "unavailable", reason: "page-evidence-no-profile" };
  const def = loaded.profile.entities[descriptor.target.entityType];
  if (def === undefined) return { status: "unavailable", reason: "page-evidence-entity-undeclared" };
  const read = await readConfinedEntityFrontmatter(root, def, slug);
  if (read.kind !== "frontmatter") return { status: "unavailable", reason: `page-evidence-target-${read.kind}` };
  const specs: ProviderInputSpecV1[] = [];
  const pathTable: Record<string, string> = {};
  // NESTED shape (P2a-r2): capture identities live under their OWN map, so a
  // captureId can never collide with the target key.
  const captureIdentity: Record<string, string> = {};
  const identity = { target: `${descriptor.target.entityType}/${slug}`, captures: captureIdentity };
  for (const capture of descriptor.captures) {
    const verified = await reverifiedSeal(root, loaded, descriptor, capture, read.meta, slug, value);
    if ("reason" in verified) return { status: "unavailable", reason: verified.reason };
    const failed = await materializeCapture(root, loaded, capture, verified.seal, specs, pathTable);
    if (failed !== null) return { status: "unavailable", reason: failed.reason };
    recordCaptureIdentity(captureIdentity, capture, verified.seal);
  }
  // The IDENTITY spec (M6r-code1): the exposure digest hashes spec CONTENT, so
  // a different source yielding identical bytes would otherwise leave the
  // digest unchanged. One synthetic input carries every captured source's
  // identity — the artifact ref, the resolved relation target, the bound run —
  // so switching any source MOVES the digest even when the bytes agree.
  specs.push({
    inputId: "page-evidence-identity", kind: "page-evidence",
    provenanceLabel: "page-evidence-identity", mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify({
      target: identity.target,
      captures: Object.fromEntries(Object.entries(captureIdentity).sort(([a], [b]) => (a < b ? -1 : 1))),
    }), "utf8"),
  });
  pathTable["page-evidence-identity"] = "identity";
  return { status: "ok", built: { specs, pathTable } };
}

/** Record one capture's SOURCE identity for the identity spec. */
function recordCaptureIdentity(
  identity: Record<string, string>, capture: PageEvidenceCaptureV2, seal: Readonly<Record<string, string>>,
): void {
  if (capture.form === "artifact-deref") identity[capture.captureId] = seal[`${capture.captureId}-ref`] ?? "";
  else if (capture.form === "relation-target") identity[capture.captureId] = seal[`${capture.captureId}-target`] ?? "";
  else if (capture.form === "run-binding") {
    identity[capture.captureId] = `${capture.expect.actionId}#${seal[`${capture.captureId}-run`] ?? ""}`;
  }
}
