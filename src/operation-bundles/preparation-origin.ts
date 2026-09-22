/**
 * @file src/operation-bundles/preparation-origin.ts
 * @description The Milestone A-owned `preparation-handoff-origin-v1` evidence
 * entry every Orchestration V2 handoff copies into the bundle (design section
 * 22.2). It is a host-authored, canonical, structured provenance object — never
 * provider text — that lets a healthy Milestone A bundle identify the preparation
 * that authored it even when the preparation store, run, or key is later
 * unavailable. It is PROVENANCE authority only: it never lets the bundle repair,
 * reinterpret, or re-execute preparation state.
 *
 * Two symmetric primitives live here. {@link buildPreparationHandoffOrigin} mints
 * the canonical bytes, their content address, and the immutable
 * {@link PreparationEvidenceRef} the bundle manifest binds by digest.
 * {@link parsePreparationHandoffOrigin} is the strict, bounded, allowlisted loader
 * a reviewer or recovery pass uses to read a copied origin back from immutable
 * evidence. The manifest's own digest covers the entry, so a tampered origin
 * cannot survive re-validation of the bundle it claims to belong to.
 */

import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { MAX_RUN_EVIDENCE_BLOB_BYTES } from "./constants.js";
import { digest as parseDigest, exact, record, textValue } from "./manifest-values.js";
import type { OperationDigest, PreparationEvidenceRef } from "./types.js";

/** The single closed kind and provenance label of a handoff-origin entry. */
export const PREPARATION_HANDOFF_ORIGIN_KIND = "preparation-handoff-origin-v1";
const ORIGIN_PROVENANCE = "preparation-handoff-origin";
const ORIGIN_MEDIA_TYPE = "application/json";
const MAX_ORIGIN_IDENTITY_BYTES = 256;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOP_KEYS = [
  "schemaVersion", "kind", "workspaceId", "preparationId", "preparationRunId",
  "preparationManifestDigest", "preparationPlanDigest", "preHandoffTransitionHash", "handoffId",
] as const;

/** The host-authored canonical provenance entry (design section 22.2). */
export interface PreparationHandoffOriginV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof PREPARATION_HANDOFF_ORIGIN_KIND;
  readonly workspaceId: string;
  readonly preparationId: string;
  readonly preparationRunId: string;
  readonly preparationManifestDigest: OperationDigest;
  readonly preparationPlanDigest: OperationDigest;
  readonly preHandoffTransitionHash: OperationDigest;
  readonly handoffId: string;
}

/** The exact inputs one origin entry binds; every one is host-authoritative. */
export interface PreparationHandoffOriginInput {
  readonly workspaceId: string;
  readonly preparationId: string;
  readonly preparationRunId: string;
  readonly preparationManifestDigest: OperationDigest;
  readonly preparationPlanDigest: OperationDigest;
  readonly preHandoffTransitionHash: OperationDigest;
  readonly handoffId: string;
}

/** The minted origin object, its canonical bytes, content address, and evidence ref. */
export interface BuiltPreparationHandoffOrigin {
  readonly origin: PreparationHandoffOriginV1;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly byteCount: number;
  readonly evidenceRef: PreparationEvidenceRef;
}

/** Require one bounded, location-free logical identity string. */
function identity(value: string, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ORIGIN_IDENTITY_BYTES
    || !IDENTITY_PATTERN.test(value)) {
    throw new Error(`preparation handoff origin ${label} is not a bounded logical identity`);
  }
  return value;
}

/** Mint the canonical origin bytes, content address, and immutable evidence ref. */
export function buildPreparationHandoffOrigin(
  input: PreparationHandoffOriginInput,
): BuiltPreparationHandoffOrigin {
  const origin: PreparationHandoffOriginV1 = {
    schemaVersion: 1, kind: PREPARATION_HANDOFF_ORIGIN_KIND,
    workspaceId: identity(input.workspaceId, "workspaceId"),
    preparationId: identity(input.preparationId, "preparationId"),
    preparationRunId: identity(input.preparationRunId, "preparationRunId"),
    preparationManifestDigest: input.preparationManifestDigest,
    preparationPlanDigest: input.preparationPlanDigest,
    preHandoffTransitionHash: input.preHandoffTransitionHash,
    handoffId: identity(input.handoffId, "handoffId"),
  };
  const bytes = canonicalBytes(origin);
  const contentDigest = canonicalDigest(origin) as OperationDigest;
  const hex = contentDigest.slice("sha256:".length);
  return {
    origin, bytes, digest: hex, byteCount: bytes.byteLength,
    evidenceRef: {
      type: PREPARATION_HANDOFF_ORIGIN_KIND, provenance: ORIGIN_PROVENANCE,
      digest: contentDigest, byteCount: bytes.byteLength, payloadRef: hex,
    },
  };
}

/** Strictly load one copied origin blob back from immutable bundle evidence. */
export function parsePreparationHandoffOrigin(text: string): PreparationHandoffOriginV1 {
  const root = record(parseBoundedUniqueJson(text, MAX_RUN_EVIDENCE_BLOB_BYTES), "preparation handoff origin");
  exact(root, TOP_KEYS);
  if (root.schemaVersion !== 1) throw new Error("preparation handoff origin schemaVersion must be 1");
  if (root.kind !== PREPARATION_HANDOFF_ORIGIN_KIND) throw new Error("preparation handoff origin kind mismatch");
  return {
    schemaVersion: 1, kind: PREPARATION_HANDOFF_ORIGIN_KIND,
    workspaceId: identity(textValue(root.workspaceId, "workspaceId", MAX_ORIGIN_IDENTITY_BYTES), "workspaceId"),
    preparationId: identity(textValue(root.preparationId, "preparationId", MAX_ORIGIN_IDENTITY_BYTES), "preparationId"),
    preparationRunId: identity(textValue(root.preparationRunId, "preparationRunId", MAX_ORIGIN_IDENTITY_BYTES), "preparationRunId"),
    preparationManifestDigest: parseDigest(root.preparationManifestDigest, "preparationManifestDigest"),
    preparationPlanDigest: parseDigest(root.preparationPlanDigest, "preparationPlanDigest"),
    preHandoffTransitionHash: parseDigest(root.preHandoffTransitionHash, "preHandoffTransitionHash"),
    handoffId: identity(textValue(root.handoffId, "handoffId", MAX_ORIGIN_IDENTITY_BYTES), "handoffId"),
  };
}
