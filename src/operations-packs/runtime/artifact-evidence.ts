/**
 * @file src/operations-packs/runtime/artifact-evidence.ts
 * @description Build the provider input specs a sealed ARTIFACT-EVIDENCE
 * descriptor names (AS-4 P4.2, D41a) — ONE function, TWO consumers, exactly
 * like its source-evidence sibling: the authority resolver computes the
 * exposure digest over these specs at seal and at leg-K revalidation; the leg
 * builder materializes the same specs into the provider's confined input
 * region.
 *
 * NOTHING SEALED IS TRUSTED, EVERYTHING SEALED IS RE-VERIFIED. The sealed ref
 * must still RESOLVE HEALTHY (the member-bearing verification: manifest, every
 * member, the directory sweep); the artifact's CURRENT manifest rows must
 * EQUAL the sealed member columns exactly (a rewritten-but-healthy bundle is
 * DRIFT, not evidence — the operator approved the sealed table); and every
 * member's bytes are REHASHED against the sealed digests and byte counts. A
 * refusal parks the leg with a named reason; the provider is never fed bytes
 * under an approved digest they no longer hash to.
 *
 * GENERIC BY CONSTRUCTION: refs, fields, and member names — no product
 * vocabulary. This same builder serves the exp-eval judge lane (D41): any
 * consumer whose capture derives a ref + member table hands it the identical
 * contract.
 */

import { createHash } from "node:crypto";
import { loadNonDefaultProfile } from "../../profile/block.js";
import { parseArtifactRef } from "../../artifacts/ref.js";
import { resolveArtifactRef } from "../../artifacts/resolve.js";
import { parseMemberEntries, type ArtifactMemberEntry } from "../../artifacts/members.js";
import {
  artifactPaths, hashArtifactBody, memberLeafPath, readArtifactBody, readArtifactMemberBytes,
} from "../../artifacts/store.js";
import type { PlanArtifactEvidenceDescriptorV1 } from "../../preparations/plan-types.js";
import type { ProviderInputSpecV1 } from "../../capability-providers/runtime/inputs.js";
import type { SourceEvidenceSpecsV1 } from "./source-evidence.js";

/** A failure names WHICH leg refused; "couldn't verify" is never "doesn't exist". */
export type ArtifactEvidenceOutcomeV1 =
  | { readonly status: "ok"; readonly built: SourceEvidenceSpecsV1 }
  | { readonly status: "unavailable"; readonly reason: string };

/** The three sealed member columns, or null when absent/mismatched. */
function columnsOf(
  descriptor: PlanArtifactEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): { names: string[]; digests: string[]; byteCounts: string[] } | null {
  const names = value[descriptor.memberNamesField];
  const digests = value[descriptor.memberDigestsField];
  const byteCounts = value[descriptor.memberByteCountsField];
  if (!Array.isArray(names) || !Array.isArray(digests) || !Array.isArray(byteCounts)) return null;
  if (names.length !== digests.length || names.length !== byteCounts.length) return null;
  return { names: names.map(String), digests: digests.map(String), byteCounts: byteCounts.map(String) };
}

/** True when the artifact's CURRENT manifest rows equal the sealed columns exactly. */
function manifestMatchesSealed(
  entries: readonly ArtifactMemberEntry[], columns: { names: string[]; digests: string[]; byteCounts: string[] },
): boolean {
  if (entries.length !== columns.names.length) return false;
  return entries.every((entry, index) =>
    entry.fileName === columns.names[index]
    && `sha256:${entry.sha256}` === columns.digests[index]
    && String(entry.bytes) === columns.byteCounts[index]);
}

/**
 * Read, verify, and build the specs one sealed artifact-evidence descriptor names.
 *
 * @param root - Absolute project root.
 * @param descriptor - The plan-sealed descriptor from the provider executor.
 * @param value - The run's frozen action-input value carrying the ref + columns.
 */
export async function buildArtifactEvidenceSpecs(
  root: string,
  descriptor: PlanArtifactEvidenceDescriptorV1,
  value: Readonly<Record<string, unknown>>,
): Promise<ArtifactEvidenceOutcomeV1> {
  const verified = await verifiedSealedEntries(root, descriptor, value);
  if ("reason" in verified) return { status: "unavailable", reason: verified.reason };
  return materializeSealedMembers(root, descriptor, verified);
}

/** Everything the materialization loop needs, verified: the entries, the type def, the store paths, the sealed columns. */
interface VerifiedSealedV1 {
  entries: readonly ArtifactMemberEntry[];
  maxMemberBytes: number;
  expectedDir: string;
  digests: string[];
  byteCounts: string[];
}

/** Health, manifest, and manifest-vs-sealed equality — every pre-read verification, or the named reason. */
async function verifiedSealedEntries(
  root: string, descriptor: PlanArtifactEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): Promise<VerifiedSealedV1 | { reason: string }> {
  const columns = columnsOf(descriptor, value);
  if (columns === null) return { reason: "artifact-evidence-columns-invalid" };
  if (columns.names.length > descriptor.maxItems) return { reason: "artifact-evidence-over-item-cap" };
  const ref = parseArtifactRef(value[descriptor.refField]);
  if (ref === null) return { reason: "artifact-evidence-ref-invalid" };
  const manifest = await healthyManifestEntries(root, ref);
  if ("reason" in manifest) return manifest;
  // THE DRIFT CHECK: a manifest differing from the sealed table is NOT what the
  // operator approved — the sealed table is the authority, the store merely
  // holds bytes. Its unique catch is forged EXTRA/DROPPED rows: every
  // store-side change already breaks the sealed Merkle-root ref itself.
  if (!manifestMatchesSealed(manifest.entries, columns)) return { reason: "artifact-evidence-manifest-drift" };
  return { ...manifest, digests: columns.digests, byteCounts: columns.byteCounts };
}

/** The pinned artifact's HEALTHY manifest entries and store geometry, or the named reason. */
async function healthyManifestEntries(
  root: string, ref: NonNullable<ReturnType<typeof parseArtifactRef>>,
): Promise<Omit<VerifiedSealedV1, "digests" | "byteCounts"> | { reason: string }> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { reason: "artifact-evidence-no-profile" };
  const def = loaded.profile.artifacts?.[ref.artifactType];
  if (def?.members === undefined) return { reason: "artifact-evidence-not-member-bearing" };
  // HEALTH FIRST: the full member-bearing verification (manifest, members, sweep).
  const resolution = await resolveArtifactRef(root, loaded.profile, ref);
  if (resolution.health !== "ok") return { reason: `artifact-evidence-unhealthy-${resolution.health}` };
  const paths = artifactPaths(root, ref.artifactType, ref.slug, def.fileName);
  const body = await readArtifactBody(root, paths, def.maxBytes);
  if (body.kind !== "ok") return { reason: `artifact-evidence-manifest-${body.kind}` };
  // BIND the read to the sealed ref: a rewrite racing between the resolve
  // above and this read is a store change, not drift in the sealed columns.
  if (hashArtifactBody(body.body) !== ref.sha256) return { reason: "artifact-evidence-manifest-raced" };
  const entries = parseMemberEntries(body.body);
  if (entries === null) return { reason: "artifact-evidence-manifest-unparseable" };
  return { entries, maxMemberBytes: def.members.maxMemberBytes, expectedDir: paths.expectedDir };
}

/** Read + REHASH each member against the SEALED digests, materializing the specs. */
async function materializeSealedMembers(
  root: string, descriptor: PlanArtifactEvidenceDescriptorV1, verified: VerifiedSealedV1,
): Promise<ArtifactEvidenceOutcomeV1> {
  const specs: ProviderInputSpecV1[] = [];
  const pathTable: Record<string, string> = {};
  let totalBytes = 0;
  for (let index = 0; index < verified.entries.length; index += 1) {
    const entry = verified.entries[index]!;
    const read = await readArtifactMemberBytes(root, memberLeafPath(verified.expectedDir, entry.fileName), verified.expectedDir, verified.maxMemberBytes);
    if (read.kind !== "ok") return { status: "unavailable", reason: `artifact-evidence-member-${read.kind}` };
    totalBytes += read.body.length;
    if (totalBytes > descriptor.maxBytes) return { status: "unavailable", reason: "artifact-evidence-over-byte-cap" };
    const digest = `sha256:${createHash("sha256").update(read.body).digest("hex")}`;
    if (digest !== verified.digests[index]) return { status: "unavailable", reason: "artifact-evidence-digest-drift" };
    if (String(read.body.length) !== verified.byteCounts[index]) return { status: "unavailable", reason: "artifact-evidence-bytecount-drift" };
    const inputId = `${descriptor.inputIdPrefix}-${index}`;
    specs.push({
      inputId, kind: descriptor.kind, provenanceLabel: descriptor.provenanceLabel,
      mediaType: descriptor.mediaType, bytes: read.body,
    });
    pathTable[inputId] = entry.fileName;
  }
  return { status: "ok", built: { specs, pathTable } };
}
