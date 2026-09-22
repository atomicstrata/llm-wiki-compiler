/**
 * @file src/preparations/initial-inputs.ts
 * @description Plans and materializes a preparation's frozen initial input set
 * (design section 11.1). Every initial input enters staging ONLY as a declared
 * caller-file or structured source: a caller file is planned as a host-minted
 * immutable descriptor whose complete digest is streamed under the confined
 * no-follow single-link policy, and a structured value is canonicalized in
 * memory. Planning is read-only and yields the ordered evidence references, the
 * per-object byte counts, and the prepared-input cardinality the locked staging
 * transaction needs for its capacity preflight. Materialization — the only path
 * that writes an evidence byte — copies each declared input into the immutable
 * create-only evidence CAS, and runs only after every cap and authority check
 * has passed. There is no caller-supplied evidence buffer: a byte that no
 * declared input materializes cannot enter preparation evidence.
 */

import {
  writePreparationEvidenceCreateOnly, type PreparationEvidenceLocation,
} from "./evidence-store.js";
import {
  materializeCallerFileInput, planCallerFileInput, prepareStructuredValueInput,
  type CallerFileSourceV1, type PreparedCallerFileV1, type PreparedInputUnavailableCode,
  type PreparedInputV1, type StructuredValueSourceV1,
} from "./inputs.js";
import type { EvidenceRefV1 } from "./types.js";

const SHA256_PREFIX = "sha256:";

/** One declared initial input: a confined caller file or a structured value. */
export type PreparationInitialInputV1 =
  | { kind: "caller-file"; source: CallerFileSourceV1 }
  | { kind: "structured"; source: StructuredValueSourceV1 };

/** One planned initial input carrying the data a later materialize consumes. */
type PlannedInitialInput =
  | { kind: "caller-file"; input: PreparedInputV1; bareDigest: string; byteCount: number; file: PreparedCallerFileV1 }
  | { kind: "structured"; input: PreparedInputV1; bareDigest: string; byteCount: number; bytes: Buffer };

/** One immutable evidence object the capacity preflight sizes before any write. */
interface InitialInputObject { digest: string; byteCount: number }

/**
 * The read-only planning result: the ordered evidence references the immutable
 * manifest records, the immutable per-object digests and byte counts staging
 * sizes its capacity preflight from, the prepared-input cardinality, and the
 * retained plans a later locked materialize copies into the CAS.
 */
export interface PlannedInitialInputSetV1 {
  evidence: readonly EvidenceRefV1[];
  objects: readonly InitialInputObject[];
  preparedInputsCount: number;
  planned: readonly PlannedInitialInput[];
}

/** Closed materialize outcome: written, or a distinct fail-closed refusal. */
type MaterializeInitialInputsOutcome =
  | { status: "materialized" }
  | { status: "unavailable"; code: PreparedInputUnavailableCode };

/** Bare lowercase SHA-256 of one prepared descriptor's evidence digest. */
function bareDigestOf(input: PreparedInputV1): string {
  return input.digest.slice(SHA256_PREFIX.length);
}

/** Plan one declared caller file into an immutable descriptor, or a refusal code. */
async function planCallerFile(
  source: CallerFileSourceV1,
): Promise<PlannedInitialInput | { code: PreparedInputUnavailableCode }> {
  const outcome = await planCallerFileInput(source);
  if (outcome.status !== "planned") return { code: outcome.code };
  const file = outcome.prepared;
  return { kind: "caller-file", input: file.input, bareDigest: bareDigestOf(file.input), byteCount: file.byteCount, file };
}

/** Canonicalize one declared structured value into an immutable descriptor. */
function planStructured(source: StructuredValueSourceV1): PlannedInitialInput {
  const prepared = prepareStructuredValueInput(source);
  return {
    kind: "structured", input: prepared.input, bareDigest: bareDigestOf(prepared.input),
    byteCount: prepared.bytes.byteLength, bytes: prepared.bytes,
  };
}

/**
 * Plan the complete declared initial input set without writing any byte. A
 * caller file that is absent, changed, oversize, or unreadable parks the whole
 * set with its distinct code; a duplicate digest is rejected so two inputs
 * cannot alias one immutable evidence object.
 */
export async function planInitialInputs(
  inputs: readonly PreparationInitialInputV1[],
): Promise<{ status: "planned"; set: PlannedInitialInputSetV1 } | { status: "unavailable"; code: PreparedInputUnavailableCode }> {
  const planned: PlannedInitialInput[] = [];
  const seen = new Set<string>();
  for (const declared of inputs) {
    const item = declared.kind === "caller-file" ? await planCallerFile(declared.source) : planStructured(declared.source);
    if ("code" in item) return { status: "unavailable", code: item.code };
    if (seen.has(item.bareDigest)) return { status: "unavailable", code: "changed-digest" };
    seen.add(item.bareDigest);
    planned.push(item);
  }
  return {
    status: "planned",
    set: {
      evidence: planned.map((item) => item.input.evidenceRef),
      objects: planned.map((item) => ({ digest: item.bareDigest, byteCount: item.byteCount })),
      preparedInputsCount: planned.length, planned,
    },
  };
}

/** Materialize one planned initial input into the immutable evidence CAS. */
async function materializeItem(
  root: string, location: PreparationEvidenceLocation, item: PlannedInitialInput,
): Promise<MaterializeInitialInputsOutcome> {
  if (item.kind === "structured") {
    await writePreparationEvidenceCreateOnly(root, location, item.bytes);
    return { status: "materialized" };
  }
  return materializeCallerFileInput(root, location, item.file);
}

/**
 * Materialize every still-missing initial input into the create-only evidence
 * CAS in deterministic digest order. A stale, changed, or unreadable caller file
 * fails closed with its distinct code so staging parks; structured values are
 * always writable from their canonical bytes.
 */
export async function materializePlannedInitialInputs(
  root: string, location: PreparationEvidenceLocation, set: PlannedInitialInputSetV1, missing: ReadonlySet<string>,
): Promise<MaterializeInitialInputsOutcome> {
  for (const item of [...set.planned].sort((a, b) => a.bareDigest.localeCompare(b.bareDigest))) {
    if (!missing.has(item.bareDigest)) continue;
    const outcome = await materializeItem(root, location, item);
    if (outcome.status === "unavailable") return outcome;
  }
  return { status: "materialized" };
}
