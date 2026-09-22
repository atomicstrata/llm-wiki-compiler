/**
 * @file src/operations-packs/runtime/authority-resolver.ts
 * @description The host-owned attempt authority resolver for a compiled pack
 * action (design section 15.3). The attempt executor calls it TWICE — under the
 * lock at intent to seal, and again under the lock at leg K to revalidate — and
 * compares the two snapshots; a difference discards the late result. That gate is
 * only real if the resolver RECOMPUTES from authoritative current state, so this
 * module reads the run's own persisted manifest and its durable evidence objects
 * back on every call. A resolver that returned a baked constant would make the
 * whole comparison tautological, which is precisely the defect the injected
 * resolver seam exists to prevent.
 *
 * WHAT IT RECOMPUTES, AND WHY THAT AND NOTHING ELSE. A host-handler phase of a
 * compiled pack action reads exactly one thing: the run's frozen initial input
 * set. So the exposure digest binds, per declared initial-input reference, BOTH
 * the persisted DECLARATION (kind, media type, provenance, digest, declared byte
 * count, sensitivity, retention) and the byte count the evidence store VERIFIED
 * when reading the object back. Either half moving is drift: a rewritten manifest
 * changes the declaration, and a replaced object changes what the store verifies.
 *
 * A PROVIDER PHASE SEALS A DIFFERENT AUTHORITY, because the exposure digest is
 * CONSUMED differently there: the provider leg requires it to equal the content
 * exposure of the input specs actually sent. A V1 provider phase receives its
 * rendered request and nothing else — no host files — so the sealed set is the
 * EMPTY spec set, and a host that attaches project content to the request fails
 * closed instead of exposing it. Sealing the run's initial-input digest there
 * would be a category error: it could never equal any spec set, so the phase
 * could never execute, and the routing would look built while being unreachable.
 *
 * THE REMAINING EXTRAS ARE OMITTED, NOT ZEROED. No phase of a compiled pack
 * action resolves a grant, plans an external effect, requests a broker, or needs
 * backend readiness — so `grantSnapshotDigest`, `effectPlanDigest`,
 * `brokerPlanDigest`, and `backendReadinessDigest` are absent. A placeholder
 * digest in any of them would seal an authority the run does not have and would
 * compare equal to itself forever.
 *
 * IT FAILS CLOSED. An unreadable manifest, or an initial-input object that is
 * absent, over-cap, unreadable, or whose bytes no longer hash to their content
 * address, resolves `unavailable` with a distinct reason — the attempt parks
 * rather than sealing an exposure the host could not confirm.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../capability-providers/ids.js";
import { readPreparationEvidence, readPreparationEvidenceBytes } from "../../preparations/evidence-store.js";
import { readPreparationManifest } from "../../preparations/manifest-store.js";
import { MAX_PREPARED_INPUT_OBJECT_BYTES } from "../../preparations/inputs.js";
import type { PreparationRunBinding } from "../../preparations/run-types.js";
import type { EvidenceRefV1 } from "../../preparations/types.js";
import { providerInputSpecsContentExposureDigest } from "../../preparations/attempts/provider.js";
import type { PhaseExecutorV1 } from "../../preparations/plan-types.js";
import { buildSourceEvidenceSpecs } from "./source-evidence.js";
import { buildArtifactEvidenceSpecs } from "./artifact-evidence.js";
import { buildPageEvidenceSpecs } from "./page-evidence.js";
import type {
  AttemptAuthorityResolutionV1, AttemptAuthorityResolverV1,
} from "../../preparations/attempts/types.js";

/** The sealed executor of a phase a capability provider performs the work of. */
type ProviderExecutor = Extract<PhaseExecutorV1, { kind: "provider-capability" }>;

/** Domain separator for this action class's input-exposure binding. */
const PACK_EXPOSURE_DOMAIN = "llmwiki-pack-action-input-exposure-v1";

const SHA256_PREFIX = "sha256:";

/** What one pack authority resolver is bound to for the life of a run. */
export interface PackAuthorityResolverInputV1 {
  readonly root: string;
  readonly binding: PreparationRunBinding;
}

/** One initial input, as DECLARED by the manifest and as VERIFIED on disk. */
interface ExposureRowV1 {
  readonly kind: string;
  readonly mediaType: string;
  readonly provenanceLabel: string;
  readonly digest: string;
  readonly declaredByteCount: number;
  readonly sensitivity: string;
  readonly retention: string;
  readonly verifiedByteCount: number;
}

/** The bare CAS key of one prefixed evidence digest. */
function bareDigest(digest: string): string {
  return digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
}

/** Read one declared initial input back and pair its declaration with the truth. */
async function exposureRow(
  input: PackAuthorityResolverInputV1, ref: EvidenceRefV1,
): Promise<ExposureRowV1 | { readonly unavailable: string }> {
  const location = { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
  const read = await readPreparationEvidence(input.root, location, bareDigest(ref.digest));
  if (read.status !== "ok") return { unavailable: `initial-input-${read.status}` };
  return {
    kind: ref.kind, mediaType: ref.mediaType, provenanceLabel: ref.provenanceLabel,
    digest: ref.digest, declaredByteCount: ref.byteCount, sensitivity: ref.sensitivity,
    retention: ref.retention, verifiedByteCount: read.byteCount,
  };
}

/** Read every declared initial input back, failing closed on the first refusal. */
async function exposureRows(
  input: PackAuthorityResolverInputV1, refs: readonly EvidenceRefV1[],
): Promise<readonly ExposureRowV1[] | { readonly unavailable: string }> {
  const rows: ExposureRowV1[] = [];
  for (const ref of refs) {
    const row = await exposureRow(input, ref);
    if ("unavailable" in row) return row;
    rows.push(row);
  }
  // Sorted by content address so the digest binds the SET, not the manifest's
  // incidental ordering — reordering two declarations is not exposure drift.
  return rows.sort((left, right) => left.digest.localeCompare(right.digest));
}

/** Recompute the exposure digest from persisted state, or say why it cannot be. */
async function resolveExposure(
  input: PackAuthorityResolverInputV1,
): Promise<AttemptAuthorityResolutionV1> {
  const manifest = await readPreparationManifest(
    input.root, input.binding.workspaceId, input.binding.preparationId);
  if (manifest.status !== "ok") return { status: "unavailable", reason: `manifest-${manifest.status}` };
  const rows = await exposureRows(input, manifest.manifest.initialEvidence);
  if ("unavailable" in rows) return { status: "unavailable", reason: rows.unavailable };
  return {
    status: "ok",
    extras: {
      inputExposureSetDigest: parseSha256Digest(
        canonicalDigest({ domain: PACK_EXPOSURE_DOMAIN, inputs: rows })),
    },
  };
}

/**
 * The authority a provider phase seals: its plan-pinned provider, and the
 * exposure of the input specs the phase will actually send.
 *
 * WITHOUT a sealed source-evidence descriptor the spec set is EMPTY — a V1
 * provider request carries no host files, and a host that attaches project
 * content fails closed instead of exposing it. WITH one, the exposure is
 * computed over the specs the SHARED builder produces from the sealed columns
 * and the bytes on disk — the same builder the leg uses, so a source edited
 * between seal and leg changes this digest and the late result is discarded,
 * which is the entire point of resolving twice.
 */
async function resolveProviderAuthority(
  input: PackAuthorityResolverInputV1, executor: ProviderExecutor,
): Promise<AttemptAuthorityResolutionV1> {
  const descriptor = executor.sourceEvidenceDescriptor;
  const artifactDescriptor = executor.artifactEvidenceDescriptor;
  const pageDescriptor = executor.pageEvidenceDescriptor;
  const pin = {
    // Recomputed from the SEALED executor rather than remembered, so the leg-K
    // revalidation compares two independent reads of the same authority.
    providerPinDigest: executor.providerPinDigest,
  };
  if (descriptor === undefined && artifactDescriptor === undefined && pageDescriptor === undefined) {
    return {
      status: "ok",
      extras: { inputExposureSetDigest: providerInputSpecsContentExposureDigest([]), ...pin },
    };
  }
  const value = await frozenActionInputValue(input);
  if ("unavailable" in value) return { status: "unavailable", reason: value.unavailable };
  // ONE evidence kind per phase (compile-refused otherwise): the exposure
  // digest is computed over whichever builder the sealed executor names.
  const built = descriptor !== undefined
    ? await buildSourceEvidenceSpecs(input.root, descriptor, value.value)
    : artifactDescriptor !== undefined
      ? await buildArtifactEvidenceSpecs(input.root, artifactDescriptor, value.value)
      : await buildPageEvidenceSpecs(input.root, pageDescriptor!, value.value);
  if (built.status !== "ok") return { status: "unavailable", reason: built.reason };
  return {
    status: "ok",
    extras: { inputExposureSetDigest: providerInputSpecsContentExposureDigest(built.built.specs as unknown as readonly Readonly<Record<string, unknown>>[]), ...pin },
  };
}

/**
 * The run's frozen action-input value, read back from its own evidence object.
 * The sealed bytes are the canonical JSON of the resolved input record, and the
 * store verifies them against their content address before returning them.
 */
async function frozenActionInputValue(
  input: PackAuthorityResolverInputV1,
): Promise<{ value: Record<string, unknown> } | { unavailable: string }> {
  const manifest = await readPreparationManifest(
    input.root, input.binding.workspaceId, input.binding.preparationId);
  if (manifest.status !== "ok") return { unavailable: `manifest-${manifest.status}` };
  const ref = manifest.manifest.initialEvidence.find((entry) => entry.kind === ACTION_INPUT_EVIDENCE_KIND);
  if (ref === undefined) return { unavailable: "action-input-evidence-missing" };
  const location = { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId };
  // The read cap IS the prepared-input contract's own object cap: a private
  // smaller constant here parked schema-valid staged actions (a 1.05 MiB input
  // compiled and staged, then failed resolution as action-input-over-cap).
  const read = await readPreparationEvidenceBytes(
    input.root, location, bareDigest(ref.digest), MAX_PREPARED_INPUT_OBJECT_BYTES);
  if (read.status !== "ok") return { unavailable: `action-input-${read.status}` };
  try {
    const parsed: unknown = JSON.parse(read.bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { unavailable: "action-input-not-a-record" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { unavailable: "action-input-undecodable" };
  }
}



/** The evidence kind `sealActionInput` records the frozen input under. */
const ACTION_INPUT_EVIDENCE_KIND = "pack-action-input";

/**
 * Build the pack action's host-owned authority resolver.
 *
 * The root and binding are copied field by field at construction, so a caller
 * retaining the input object cannot retarget which run the seal and the leg-K
 * revalidation read between the two calls.
 *
 * @param input - The project root and the durable run binding to recompute from.
 * @returns A resolver that recomputes the input-exposure digest on every call.
 */
export function createPackAuthorityResolver(
  input: PackAuthorityResolverInputV1,
): AttemptAuthorityResolverV1 {
  const pinned: PackAuthorityResolverInputV1 = {
    root: input.root,
    binding: {
      runId: input.binding.runId, preparationId: input.binding.preparationId,
      manifestDigest: input.binding.manifestDigest, workspaceId: input.binding.workspaceId,
      keyEpochId: input.binding.keyEpochId,
    },
  };
  return {
    resolve: async (context) => context.executor.kind === "provider-capability"
      ? resolveProviderAuthority(pinned, context.executor)
      : resolveExposure(pinned),
  };
}
