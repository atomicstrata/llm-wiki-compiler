/**
 * @file src/preparations/service-run-lookup.ts
 * @description Locating one preparation run by the id an operator typed, and
 * saying honestly why it could not be located — the read leg three service
 * operations share.
 *
 * ONE HOME, because the refusal taxonomy is the part that is easy to get wrong
 * and easy to copy wrong. `fail` grew it first; `cancel` and `recovery` need the
 * same answers, and a second copy is how "no such preparation run" comes to be
 * reported for a degraded scan in one operation and not in its sibling. Three
 * copies of one predicate disagreeing is the recurring defect in this program.
 *
 * D-10-4 AT THIS READ LEG SPECIFICALLY: could-not-see and does-not-exist are
 * distinct answers, and only an authoritative scan may say does-not-exist.
 *
 * THE LOOKUP IS SPLIT IN TWO ON PURPOSE. Resolving a run needs the preparation
 * KEY — the binding is key-epoch-bound — and every operation that must read
 * durable run state therefore inherits the key as a precondition. `cancel` must
 * not: its whole reason for being lock-free is that it lands when the project is
 * wedged, and a wedged project is exactly the one whose key may be unreadable.
 * So the manifest lookup stands alone, and the run read is layered on top of it
 * by the operations that genuinely need durable state.
 *
 * ONE BODY PER QUESTION, OVER THE LOOKUP'S OWN READS. Each `…From` function is
 * the single body; it takes `PreparationRunLookupReads` and no project root. The
 * four root-named functions keep their signatures and delegate to it over the
 * private local-disk reads, built on each call. What is bound here is THIS
 * FILE'S decisions: the miss taxonomy, the read order, and the sealed-input
 * decoding. The four reads under it are NOT made storage-neutral by being
 * named: the inventory scan, the key read, the run read (which authenticates the
 * leaf against the key it reads itself) and the evidence read (cap and digest)
 * each decide things of their own and each still takes a project root. Nothing
 * here selects a backend.
 */

import { scanPreparationInventory } from "./capacity.js";
import type { PreparationInventory } from "./capacity.js";
import type { CommandPreparationPass } from "./recovery.js";
import { readPreparationEvidenceBytes } from "./evidence-store.js";
import type { PreparationEvidenceBytesRead, PreparationEvidenceLocation } from "./evidence-store.js";
import { readPreparationKeyEpoch } from "./key-epoch.js";
import type { PreparationManifestV1 } from "./manifest-parse.js";
import { preparationPassReads, type PreparationPassReads } from "./pass-reads.js";
import { bindingFor } from "./references.js";
import { readPreparationRun } from "./run-store.js";
import type { PreparationRunRead } from "./run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "./run-types.js";

/**
 * WHICH KIND of answer a failed lookup is (D-10-4), carried as a field rather
 * than inferred from the message.
 *
 * `denied` is a settled fact about the STORE — this run is not there, or this is
 * not a project — and no retry changes it. `unavailable` is a fact about this
 * OBSERVER: something could not be read, and the same call may answer differently
 * later or from another host. Every consumer that renders an exit code, a retry
 * decision or an operator instruction needs the two apart, and the reason STRING
 * cannot supply it: reading intent out of prose is how "could not see" came to be
 * reported as "does not qualify" at three of this file's legs.
 */
export type PreparationLookupFailureV1 = "denied" | "unavailable";

/** One located manifest, or the reason the lookup could not produce one. */
export type PreparationManifestLookupV1 =
  | {
    readonly ok: false;
    readonly failure: PreparationLookupFailureV1;
    readonly reason: string;
  }
  | { readonly ok: true; readonly manifest: PreparationManifestV1 };

/** One located run and its authenticated binding, or why neither was reached. */
export type PreparationRunLookupV1 =
  | {
    readonly ok: false;
    readonly failure: PreparationLookupFailureV1;
    readonly reason: string;
  }
  | {
    readonly ok: true;
    readonly binding: PreparationRunBinding;
    readonly run: PreparationRunV1;
  };

/** One classified miss, as every failing leg below returns it. */
type LookupMiss = Extract<PreparationRunLookupV1, { ok: false }>;

/**
 * What the run lookup asks of the preparation store. Owned by the lookup; no
 * read takes a project root.
 */
export interface PreparationRunLookupReads {
  /** The store's manifests and its scan problems. */
  scanInventory(): Promise<Pick<PreparationInventory, "manifests" | "problems">>;
  /** Whether the preparation key can be read, and its epoch. NEVER the key bytes. */
  readKeyEpoch(): Promise<
    | { status: "ok"; keyEpochId: PreparationRunBinding["keyEpochId"] }
    | { status: "absent" }
    | { status: "unavailable" }
  >;
  /** One run leaf by its binding, authenticated by whatever answers. */
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
  /** One evidence object's bytes by location and hex digest, refused above `maxBytes`. */
  readEvidenceBytes(
    location: PreparationEvidenceLocation, digest: string, maxBytes: number,
  ): Promise<PreparationEvidenceBytesRead>;
}

/**
 * The local-disk reads for one project root, built per call: each closure calls
 * the imported store function when it is asked, never earlier. Exported for the
 * page-evidence bound witness; internal, in no package index and not package API.
 */
export function diskPreparationRunLookupReads(root: string): PreparationRunLookupReads {
  return {
    scanInventory: () => scanPreparationInventory(root),
    readKeyEpoch: () => readPreparationKeyEpoch(root),
    readRun: (binding) => readPreparationRun(root, binding),
    readEvidenceBytes: (location, digest, maxBytes) =>
      readPreparationEvidenceBytes(root, location, digest, maxBytes),
  };
}

/**
 * The reads of ONE lookup as one pass (`pass-reads.ts`): the scan, the key and
 * the run are read back to back with nothing written between, so the scan's
 * key read is the key the run is authenticated under, and the run read may use
 * the leaf bytes the scan's walk read once it proves them current. A lookup
 * under the project lock may hand in the hold's own `pass` and append with it.
 */
function lookupPassReads(
  root: string, pass: PreparationPassReads,
  scanInventory: () => Promise<PreparationInventory> = () => scanPreparationInventory(root, {}, pass),
): PreparationRunLookupReads {
  return {
    scanInventory,
    readKeyEpoch: pass.readKeyEpoch,
    readRun: pass.readRun,
    readEvidenceBytes: (location, digest, maxBytes) =>
      readPreparationEvidenceBytes(root, location, digest, maxBytes),
  };
}

/**
 * Why a manifest miss is not evidence of absence.
 *
 * A degraded scan DROPS manifests it could not read, so "not in the list" over a
 * scan with problems means could-not-see. Only an authoritative scan can say
 * does-not-exist.
 */
function missReason(problemCount: number, manifestCount: number): LookupMiss {
  // UNAVAILABLE, and the shipped message already said so in prose — "this run may
  // exist" is the definition of could-not-see. Only the classification was
  // missing, so `show` rendered it as a denial and its CLI exited 1 where the
  // documented retryable code is 2.
  if (problemCount > 0) {
    return {
      ok: false, failure: "unavailable",
      reason: "the preparation scan was not authoritative; this run may exist",
    };
  }
  // AN EMPTY STORE IS NOT AN AUTHORITATIVE ABSENCE. A directory with no
  // `.llmwiki` has zero problems and zero manifests, so the does-not-exist
  // branch fired on it — and since the CLI root is `process.cwd()` with no
  // upward discovery, an operator one directory deep was told their run did not
  // exist.
  // BOTH DENIALS, and deliberately: an empty store and an authoritative scan that
  // does not contain the id are settled facts a retry cannot change. Not-a-project
  // in particular must not land on the retry code.
  if (manifestCount === 0) {
    return { ok: false, failure: "denied", reason: "no preparation store here; run from the project root" };
  }
  return { ok: false, failure: "denied", reason: "no such preparation run" };
}

/**
 * Locate one run's durable MANIFEST by the id the caller named.
 *
 * Reads no key and no run leaf, so it answers for a project whose key is
 * unreadable. The manifest carries the workspace id, which is all a run's
 * advisory sidecar path needs.
 *
 * @param root - The project root to scan.
 * @param runId - The run id the caller named.
 * @returns The manifest, or the honest reason it was not located.
 */
export async function locatePreparationManifest(
  root: string, runId: string,
): Promise<PreparationManifestLookupV1> {
  return locatePreparationManifestFrom(diskPreparationRunLookupReads(root), runId);
}

/** {@link locatePreparationManifest} over the lookup's reads: the one body. */
export async function locatePreparationManifestFrom(
  reads: PreparationRunLookupReads, runId: string,
): Promise<PreparationManifestLookupV1> {
  const inventory = await reads.scanInventory();
  const manifest = inventory.manifests.find((candidate) => candidate.runId === runId);
  return manifest === undefined
    ? missReason(inventory.problems.length, inventory.manifests.length)
    : { ok: true, manifest };
}

/** Read one bound run, carrying the typed reason when it cannot be read. */
async function readBoundRun(
  reads: PreparationRunLookupReads, binding: PreparationRunBinding,
): Promise<PreparationRunLookupV1> {
  const read = await reads.readRun(binding);
  // THE SUBSTRATE ALREADY SPLIT THESE and this leg collapsed them back. An absent
  // leaf is the store saying the run is not there; every other non-ok status is a
  // corrupt or unreadable leaf, which is this observer failing to read a run that
  // may be perfectly intact for the next reader. Corrupting a real run leaf made
  // `show` answer `refused`, so an operator was told their run did not qualify
  // when it could not be read.
  if (read.status === "absent") {
    return { ok: false, failure: "denied", reason: "run is unreadable: absent" };
  }
  if (read.status !== "ok") {
    return { ok: false, failure: "unavailable", reason: `run is unreadable: ${read.code}` };
  }
  return { ok: true, binding, run: read.run };
}

/**
 * Read the run belonging to a manifest THIS CALLER ALREADY LOCATED.
 *
 * Exists so an operation that needs both the manifest and the run observes the
 * inventory ONCE. Composing the two public entry points instead would scan
 * twice, and two scans of a live store can disagree — the second-observation
 * shape this program has already had to remove from a gate.
 *
 * @param root - The project root the manifest was located in.
 * @param manifest - The manifest a prior lookup resolved.
 * @returns The bound run, or the honest reason it was not reached.
 */
export async function readPreparationRunForManifest(
  root: string, manifest: PreparationManifestV1,
): Promise<PreparationRunLookupV1> {
  return readPreparationRunForManifestFrom(lookupPassReads(root, preparationPassReads(root)), manifest);
}

/** {@link readPreparationRunForManifest} over the lookup's reads: the one body. */
export async function readPreparationRunForManifestFrom(
  reads: PreparationRunLookupReads, manifest: PreparationManifestV1,
): Promise<PreparationRunLookupV1> {
  const key = await reads.readKeyEpoch();
  // UNAVAILABLE FOR BOTH NON-OK STATUSES, absent included. A key that is missing
  // while a manifest sits beside it is a torn store, not evidence about the run —
  // absence of the thing that authenticates a binding says nothing about whether
  // the binding's run exists.
  //
  // NOT REACHABILITY-TRACED FROM `show`: its project-readiness leg refuses an
  // unreadable key before this one is reached, measured rather than assumed (a
  // chmod on the key file answers `unavailable` from readiness). This is
  // classified correctly for the consumers that do not take that leg, and as
  // defence against a key that turns unreadable between the two reads.
  if (key.status !== "ok") {
    return { ok: false, failure: "unavailable", reason: `preparation key is ${key.status}` };
  }
  return readBoundRun(reads, bindingFor(manifest, key.keyEpochId));
}

/**
 * Locate one run and its authenticated binding by the id the caller named.
 *
 * @param root - The project root to scan.
 * @param runId - The run id the caller named.
 * @param pass - The caller's pass for this hold of the lock; a fresh one by default.
 * @returns The bound run, or the honest reason it was not reached.
 */
export async function resolvePreparationRun(
  root: string, runId: string, pass: PreparationPassReads = preparationPassReads(root),
): Promise<PreparationRunLookupV1> {
  return resolvePreparationRunFrom(lookupPassReads(root, pass), runId);
}

/**
 * {@link resolvePreparationRun} on the pass of a command holding the lock: the
 * command's scan, which is the gate's own when the gate handed one over
 * (`commandPreparationPass`), then the run read under the same reads.
 */
export async function resolvePreparationRunOnPass(
  root: string, runId: string, command: CommandPreparationPass,
): Promise<PreparationRunLookupV1> {
  return resolvePreparationRunFrom(lookupPassReads(root, command.reads, () => command.scanInventory()), runId);
}

/** {@link resolvePreparationRun} over the lookup's reads: one scan, then the run read. */
export async function resolvePreparationRunFrom(
  reads: PreparationRunLookupReads, runId: string,
): Promise<PreparationRunLookupV1> {
  const located = await locatePreparationManifestFrom(reads, runId);
  return located.ok ? readPreparationRunForManifestFrom(reads, located.manifest) : located;
}

/** A run's sealed initial input, decoded — or why it could not be read. */
export type PreparationInitialInputLookupV1 =
  | { readonly ok: true; readonly record: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

/**
 * Read and decode a run's SEALED initial input record (the frozen action
 * input) from the run's own evidence store — the one authority every consumer
 * asking "what was this run staged with?" shares. A lock-free read.
 */
export async function readPreparationInitialInput(
  root: string, manifest: PreparationManifestV1,
): Promise<PreparationInitialInputLookupV1> {
  return readPreparationInitialInputFrom(diskPreparationRunLookupReads(root), manifest);
}

/** {@link readPreparationInitialInput} over the lookup's reads: the one body. */
export async function readPreparationInitialInputFrom(
  reads: PreparationRunLookupReads, manifest: PreparationManifestV1,
): Promise<PreparationInitialInputLookupV1> {
  const inputSet = manifest.plan.initialInputSet;
  const read = await reads.readEvidenceBytes(
    { workspaceId: manifest.workspaceId, preparationId: manifest.preparationId },
    inputSet.digest.replace(/^sha256:/, ""), inputSet.byteCount);
  if (read.status !== "ok") return { ok: false, reason: `sealed input is ${read.status}` };
  try {
    const parsed = JSON.parse(read.bytes.toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ok: true, record: parsed as Record<string, unknown> }
      : { ok: false, reason: "sealed input is not a JSON object" };
  } catch {
    return { ok: false, reason: "sealed input is not JSON" };
  }
}
