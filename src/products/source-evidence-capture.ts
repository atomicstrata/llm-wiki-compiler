/**
 * @file src/products/source-evidence-capture.ts
 * @description Host-side capture of source-evidence rows (spec §4.1.4): the
 * caller names PATHS; this reads each file under `sources/` and computes the
 * digest and byte-count columns the compiler will seal.
 *
 * THE HOST OWNS THE DIGESTS. A supplied digest or byte-count column is
 * OVERWRITTEN, never trusted: it is an assertion about bytes the caller does
 * not own, and sealing one would let a plan carry a digest that never matched
 * the file — defeating the run-time drift check exactly when it matters.
 *
 * It reads through the SAME confined path discipline the runtime's builder
 * uses (flat leaves under `sources/`, no separators, no dot-segments), so what
 * the host seals and what the run later re-verifies are reads of the same
 * shape — a path this refuses is a path the run would have refused.
 */

import path from "node:path";
import { isFlatSourceLeaf as isFlatLeaf } from "../utils/flat-source-leaf.js";
import { createHash } from "node:crypto";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import type { PackActionInputValueV2, WorkspaceOperationsPackV2 } from "../operations-packs/types.js";
import type { SourceEvidenceDescriptorV2 } from "../operations-packs/recipe-types.js";

/** The retention directory paths are relative to; matches the runtime builder. */
const SOURCES_DIR = "sources";

/** One capture outcome: the input with host-owned columns, or a named refusal. */
export type SourceEvidenceCaptureV1 =
  | { readonly input: Readonly<Record<string, PackActionInputValueV2>> }
  | { readonly refused: string };

/** The descriptor of the action's recipe's provider phase, when one exists. */
function descriptorFor(
  pack: WorkspaceOperationsPackV2, actionId: string,
): SourceEvidenceDescriptorV2 | undefined | { readonly refused: string } {
  const declared = declaredDescriptors(pack, actionId);
  // Mirrors the compiler's refusal: capturing only the FIRST would leave the
  // second phase's digest columns undefined — an accepted configuration that
  // could never compile, surfacing far from its cause.
  if (declared.length > 1) {
    return { refused: `${declared.length} provider phases declare a sourceEvidenceDescriptor; one action may carry at most one` };
  }
  return declared[0];
}

/** Every descriptor the action's recipe declares, in phase order. */
function declaredDescriptors(
  pack: WorkspaceOperationsPackV2, actionId: string,
): SourceEvidenceDescriptorV2[] {
  return declaredProviderPhaseValues(pack, actionId, "sourceEvidenceDescriptor");
}

/**
 * Every value the action's recipe's provider phases declare under `key`, in
 * phase order — the ONE recipe walk both evidence captures share.
 */
export function declaredProviderPhaseValues<T>(
  pack: WorkspaceOperationsPackV2, actionId: string, key: string,
): T[] {
  const action = pack.actions[actionId];
  const recipeRef = (action?.execution as { recipeRef?: string } | undefined)?.recipeRef;
  const recipe = recipeRef === undefined ? undefined : pack.recipes[recipeRef];
  const declared: T[] = [];
  for (const phase of recipe?.phases ?? []) {
    if (phase.kind !== "provider") continue;
    const value = (phase.body as unknown as Record<string, unknown>)[key] as T | undefined;
    if (value !== undefined) declared.push(value);
  }
  return declared;
}

/**
 * Capture the host-owned columns for one action's input, when its recipe's
 * provider phase seals a source-evidence descriptor. An action without one
 * returns the input untouched.
 *
 * @param root - Absolute project root; sources are read under `root/sources`.
 * @param pack - The verified pack the action belongs to.
 * @param actionId - The resolved canonical action id.
 * @param input - The caller's input; the paths column is read, the digest and
 *   byte-count columns are host-computed and overwrite any supplied values.
 */
export async function captureSourceEvidenceInput(
  root: string, pack: WorkspaceOperationsPackV2, actionId: string,
  input: Readonly<Record<string, PackActionInputValueV2>>,
): Promise<SourceEvidenceCaptureV1> {
  const descriptor = descriptorFor(pack, actionId);
  if (descriptor === undefined) return { input };
  if ("refused" in descriptor) return descriptor;
  const supplied = input[descriptor.pathsField];
  const paths = Array.isArray(supplied) ? supplied.map(String) : typeof supplied === "string" ? [supplied] : [];
  if (paths.length === 0) return { refused: `source-evidence input names no ${descriptor.pathsField}` };
  if (paths.length > descriptor.maxItems) {
    return { refused: `${paths.length} source-evidence paths exceed the sealed maxItems of ${descriptor.maxItems}` };
  }
  const sourcesRoot = path.join(root, SOURCES_DIR);
  const digests: string[] = [];
  const byteCounts: string[] = [];
  let totalBytes = 0;
  for (const relative of paths) {
    if (!isFlatLeaf(relative)) return { refused: `source-evidence path ${JSON.stringify(relative)} is not a flat leaf under sources/` };
    const read = await readConfinedLeafBuffer(
      sourcesRoot, path.join(sourcesRoot, relative), sourcesRoot, descriptor.maxBytes);
    if (read.kind !== "ok") return { refused: `source ${relative} is ${read.kind} under sources/` };
    totalBytes += read.body.length;
    if (totalBytes > descriptor.maxBytes) return { refused: `source-evidence bytes exceed the sealed maxBytes of ${descriptor.maxBytes}` };
    digests.push(`sha256:${createHash("sha256").update(read.body).digest("hex")}`);
    byteCounts.push(String(read.body.length));
  }
  return {
    input: {
      ...input,
      [descriptor.pathsField]: paths,
      [descriptor.digestsField]: digests,
      [descriptor.byteCountsField]: byteCounts,
    },
  };
}
