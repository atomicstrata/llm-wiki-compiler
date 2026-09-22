/**
 * @file test/fixtures/artifact-evidence-fixture.ts
 * @description The one artifact-evidence descriptor + sealed-value vocabulary
 * both the unit and runner witnesses speak: the synthetic `bundle` consumer's
 * descriptor, the sealed columns a capture would produce for the standard
 * two-member bundle, and the canonical FORGED-digest drift input.
 */
import { twoMembers, shaOf } from "./member-artifact-root.js";
import type { PlanArtifactEvidenceDescriptorV1 } from "../../src/preparations/plan-types.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";

/** The synthetic bundle consumer's descriptor — no product vocabulary (§4.6). */
export const EVIDENCE_DESCRIPTOR: PlanArtifactEvidenceDescriptorV1 = {
  refField: "bundle-ref", memberNamesField: "member-names", memberDigestsField: "member-digests",
  memberByteCountsField: "member-byte-counts", inputIdPrefix: "member", kind: "artifact-evidence",
  provenanceLabel: "bundle-member", mediaType: "application/octet-stream",
  maxItems: 8, maxBytes: 65536, pathTableKey: "members",
};

/** The sealed value a capture would produce for the standard two-member bundle. */
export function sealedBundleValue(ref: ArtifactRef): Record<string, unknown> {
  const sorted = [...twoMembers()].sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
  return {
    "bundle-ref": `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`,
    "member-names": sorted.map((file) => file.fileName),
    "member-digests": sorted.map((file) => `sha256:${shaOf(file.bytes)}`),
    "member-byte-counts": sorted.map((file) => String(file.bytes.byteLength)),
  };
}

/** The sealed columns with the SECOND digest forged — the canonical drift input. */
export function forgeSecondDigest(sealed: Record<string, unknown>): Record<string, unknown> {
  return { ...sealed, "member-digests": [(sealed["member-digests"] as string[])[0]!, `sha256:${"d".repeat(64)}`] };
}
