/**
 * @file src/operations-packs/runtime/source-evidence.ts
 * @description Build the provider input specs a sealed source-evidence
 * descriptor names (spec §2.1 generic change 1) — ONE function, TWO consumers.
 *
 * The authority resolver computes the exposure digest over these specs at seal
 * and again at leg-K revalidation; the leg builder materializes the same specs
 * into the provider's confined input region. They MUST call this one builder:
 * the runtime compares the sealed exposure against the exposure of the specs
 * actually sent (`attempts/provider.ts`), so two builders that drift would
 * surface as an unexplained refusal rather than as the bug they are.
 *
 * DIGESTS ARE VERIFIED HERE, NOT TRUSTED. The sealed columns say what the
 * operator approved; this reads the bytes on disk and refuses on any mismatch —
 * a source edited after approval must fail the run, not feed the provider
 * different bytes under an approved digest.
 *
 * PATHS ARE FLAT LEAVES UNDER `sources/`, read through the repository's one
 * hardened confined reader. The retention store is flat today; a path carrying
 * a separator or a dot-segment is refused rather than resolved, because a
 * traversal that "worked" would read outside the store the operator approved.
 */

import path from "node:path";
import { isFlatSourceLeaf as isFlatLeaf } from "../../utils/flat-source-leaf.js";
import { createHash } from "node:crypto";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import type { PlanSourceEvidenceDescriptorV1 } from "../../preparations/plan-types.js";
import type { ProviderInputSpecV1 } from "../../capability-providers/runtime/inputs.js";

/** The retention directory the descriptor's paths are relative to. */
const SOURCES_DIR = "sources";

/** The built specs plus the inputId→relative-path table the provider reads. */
export interface SourceEvidenceSpecsV1 {
  readonly specs: readonly ProviderInputSpecV1[];
  readonly pathTable: Readonly<Record<string, string>>;
}

/** A failure names WHICH leg refused; "couldn't read" is never "doesn't exist". */
export type SourceEvidenceOutcomeV1 =
  | { readonly status: "ok"; readonly built: SourceEvidenceSpecsV1 }
  | { readonly status: "unavailable"; readonly reason: string };

/** The three sealed columns, or null when the descriptor names absent fields. */
function columnsOf(
  descriptor: PlanSourceEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): { paths: string[]; digests: string[]; byteCounts: string[] } | null {
  const paths = value[descriptor.pathsField];
  const digests = value[descriptor.digestsField];
  const byteCounts = value[descriptor.byteCountsField];
  if (!Array.isArray(paths) || !Array.isArray(digests) || !Array.isArray(byteCounts)) return null;
  if (paths.length !== digests.length || paths.length !== byteCounts.length) return null;
  return {
    paths: paths.map(String), digests: digests.map(String), byteCounts: byteCounts.map(String),
  };
}

/**
 * Read, verify, and build the specs one sealed descriptor names.
 *
 * @param root - Absolute project root; sources are read under `root/sources`.
 * @param descriptor - The plan-sealed descriptor from the provider executor.
 * @param value - The run's frozen action-input value carrying the three columns.
 */
export async function buildSourceEvidenceSpecs(
  root: string,
  descriptor: PlanSourceEvidenceDescriptorV1,
  value: Readonly<Record<string, unknown>>,
): Promise<SourceEvidenceOutcomeV1> {
  const columns = columnsOf(descriptor, value);
  if (columns === null) return { status: "unavailable", reason: "source-evidence-columns-invalid" };
  if (columns.paths.length > descriptor.maxItems) {
    return { status: "unavailable", reason: "source-evidence-over-item-cap" };
  }
  const sourcesRoot = path.join(root, SOURCES_DIR);
  const specs: ProviderInputSpecV1[] = [];
  const pathTable: Record<string, string> = {};
  let totalBytes = 0;
  for (let index = 0; index < columns.paths.length; index += 1) {
    const relative = columns.paths[index]!;
    if (!isFlatLeaf(relative)) return { status: "unavailable", reason: "source-evidence-path-unconfined" };
    const read = await readConfinedLeafBuffer(
      sourcesRoot, path.join(sourcesRoot, relative), sourcesRoot, descriptor.maxBytes);
    if (read.kind !== "ok") return { status: "unavailable", reason: `source-evidence-read-${read.kind}` };
    totalBytes += read.body.length;
    if (totalBytes > descriptor.maxBytes) return { status: "unavailable", reason: "source-evidence-over-byte-cap" };
    const digest = `sha256:${createHash("sha256").update(read.body).digest("hex")}`;
    // THE DRIFT CHECK: the sealed digest is what the operator approved; bytes
    // that no longer hash to it must refuse, never feed the provider.
    if (digest !== columns.digests[index]) return { status: "unavailable", reason: "source-evidence-digest-drift" };
    if (String(read.body.length) !== columns.byteCounts[index]) {
      return { status: "unavailable", reason: "source-evidence-bytecount-drift" };
    }
    const inputId = `${descriptor.inputIdPrefix}-${index}`;
    specs.push({
      inputId, kind: descriptor.kind, provenanceLabel: descriptor.provenanceLabel,
      mediaType: descriptor.mediaType, bytes: read.body,
    });
    pathTable[inputId] = relative;
  }
  return { status: "ok", built: { specs, pathTable } };
}
