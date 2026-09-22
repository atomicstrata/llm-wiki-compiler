/**
 * @file src/products/artifact-evidence-capture.ts
 * @description Host-side capture of the artifact-evidence columns (AS-4 P4.2,
 * D41): the caller's input names a hash-pinned artifact REF (the consumer's
 * own capture derives it — a caller-chosen ref proves only "these bytes were
 * behind the ref the caller named", which is why the ref must ALSO verify
 * here); this CAPTURE-TIME VERIFIES the ref end to end (`resolveArtifactRef`
 * with the full member-bearing verification) and computes the member columns
 * FROM THE VERIFIED MANIFEST. Supplied member columns are OVERWRITTEN, never
 * trusted. An absent, unpinned, or unhealthy ref REFUSES before staging.
 *
 * At run time the sibling builder re-verifies everything again — capture-time
 * verification AND runtime rehash are BOTH §5a legs, and neither substitutes
 * for the other.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { declaredProviderPhaseValues } from "./source-evidence-capture.js";
import { parseArtifactRef } from "../artifacts/ref.js";
import { resolveArtifactRef } from "../artifacts/resolve.js";
import { parseMemberEntries } from "../artifacts/members.js";
import { artifactPaths, hashArtifactBody, readArtifactBody } from "../artifacts/store.js";
import type { PackActionInputValueV2, WorkspaceOperationsPackV2 } from "../operations-packs/types.js";
import type { ArtifactEvidenceDescriptorV2 } from "../operations-packs/recipe-types.js";

/** One capture outcome: the input with host-owned columns, or a named refusal. */
export type ArtifactEvidenceCaptureV1 =
  | { readonly input: Readonly<Record<string, PackActionInputValueV2>> }
  | { readonly refused: string };

/** The action's recipe's sole artifact-evidence descriptor, when one exists. */
function descriptorFor(
  pack: WorkspaceOperationsPackV2, actionId: string,
): ArtifactEvidenceDescriptorV2 | undefined | { readonly refused: string } {
  const declared = declaredProviderPhaseValues<ArtifactEvidenceDescriptorV2>(pack, actionId, "artifactEvidenceDescriptor");
  if (declared.length > 1) {
    return { refused: `${declared.length} provider phases declare an artifactEvidenceDescriptor; one action may carry at most one` };
  }
  return declared[0];
}

/**
 * Capture the host-owned member columns for one action's input, when its
 * recipe's provider phase seals an artifact-evidence descriptor. An action
 * without one returns the input untouched.
 *
 * @param root - Absolute project root.
 * @param pack - The verified pack the action belongs to.
 * @param actionId - The resolved canonical action id.
 * @param input - The caller's input; the ref field is verified, the member
 *   columns are host-computed from the verified manifest and overwrite any
 *   supplied values.
 */
export async function captureArtifactEvidenceInput(
  root: string, pack: WorkspaceOperationsPackV2, actionId: string,
  input: Readonly<Record<string, PackActionInputValueV2>>,
): Promise<ArtifactEvidenceCaptureV1> {
  const descriptor = descriptorFor(pack, actionId);
  if (descriptor === undefined) return { input };
  if ("refused" in descriptor) return descriptor;
  const ref = parseArtifactRef(input[descriptor.refField]);
  if (ref === null) return { refused: `artifact-evidence input carries no pinned ref under ${descriptor.refField}` };
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { refused: "artifact evidence requires an active profile" };
  const def = loaded.profile.artifacts?.[ref.artifactType];
  if (def?.members === undefined) return { refused: `artifact type ${JSON.stringify(ref.artifactType)} is not member-bearing` };
  const resolution = await resolveArtifactRef(root, loaded.profile, ref);
  if (resolution.health !== "ok") return { refused: `the pinned ${ref.artifactType} artifact is ${resolution.health}` };
  const body = await readArtifactBody(root, artifactPaths(root, ref.artifactType, ref.slug, def.fileName), def.maxBytes);
  if (body.kind !== "ok") return { refused: `the pinned artifact's manifest is ${body.kind}` };
  // BIND the read to the verified ref: `resolveArtifactRef` above verified the
  // store, but a concurrent same-slug rewrite between that check and this read
  // would seal ref A beside B's columns — a compile that can never run.
  if (hashArtifactBody(body.body) !== ref.sha256) {
    return { refused: "the pinned artifact was rewritten during capture; retry" };
  }
  const entries = parseMemberEntries(body.body);
  if (entries === null) return { refused: "the pinned artifact's manifest is unparseable" };
  if (entries.length > descriptor.maxItems) {
    return { refused: `${entries.length} members exceed the sealed maxItems of ${descriptor.maxItems}` };
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > descriptor.maxBytes) {
    return { refused: `${totalBytes} member bytes exceed the sealed maxBytes of ${descriptor.maxBytes}` };
  }
  return {
    input: {
      ...input,
      [descriptor.memberNamesField]: entries.map((entry) => entry.fileName),
      [descriptor.memberDigestsField]: entries.map((entry) => `sha256:${entry.sha256}`),
      [descriptor.memberByteCountsField]: entries.map((entry) => String(entry.bytes)),
    },
  };
}
