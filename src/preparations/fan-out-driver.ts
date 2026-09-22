/**
 * @file src/preparations/fan-out-driver.ts
 * @description The runner's fan-out phase drivers (Chunk 3 unit B): the two
 * expansion kinds that drive more than one phase instance. A `map` phase reads
 * its source phase's output evidence, decodes the items, enumerates the
 * bounded/de-duplicated instance set, and drives each. A `bounded-repeat` phase
 * drives one iteration at a time, reading each committed iteration's own output
 * evidence to decide — via the pure `repeatIterationDecision` — whether to run
 * the next, converge, or apply the limit disposition.
 *
 * These live outside `runner.ts` so the coordinator keeps one responsibility;
 * the runner injects `driveInstance` (its single-instance attempt loop) so this
 * module never reaches into the attempt machinery. The `RunPreparation*` types
 * are imported type-only from the runner — erased at runtime, so no cycle.
 */

import { readPreparationEvidenceBytes } from "./evidence-store.js";
import { derivePhaseInstanceId, repeatExpansionIdentity, singleExpansionIdentity } from "./ids.js";
import {
  enumerateMapExpansion, repeatIterationDecision, type RepeatContinuationInputV1,
} from "./expansion.js";
import type { NormalizedPhaseV1 } from "./plan-types.js";
import { readPreparationRun } from "./run-store.js";
import type { RunPreparationInputV1, RunPreparationResultV1 } from "./runner.js";

/** Cap on decodable source-evidence bytes for one fan-out. */
const MAX_SOURCE_EVIDENCE_BYTES = 4 * 1024 * 1024;

/** The runner's single-instance attempt loop, injected so this module never owns it. */
export type DriveInstanceFn =
  (logicalPhaseId: string, expansionIdentity: string) => Promise<RunPreparationResultV1 | null>;

/**
 * Drive a `map` phase: read the source phase's output evidence, decode its
 * items through the pack capability, enumerate the bounded/de-duplicated
 * instance set, and drive each. The overflow deficit is surfaced in the
 * refusal reason for now; threading it into the completeness record is the
 * next unit.
 */
export async function driveMapPhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  if (input.decodeExpansionItems === undefined) {
    return { status: "refused", runId: input.binding.runId, reason: `map phase ${phase.logicalPhaseId} needs an item decoder` };
  }
  const items = await readSourceItems(input, phase, expansion);
  if (typeof items === "string") return { status: "refused", runId: input.binding.runId, reason: items };
  const enumerated = enumerateMapExpansion(items, expansion);
  if (enumerated.status !== "ok") {
    return { status: "refused", runId: input.binding.runId, reason: `fan-out of ${phase.logicalPhaseId}: ${enumerated.reason}` };
  }
  for (const instance of enumerated.instances) {
    const outcome = await driveInstance(phase.logicalPhaseId, instance.expansionIdentity);
    if (outcome !== null) return outcome;
  }
  return null;
}

/**
 * Drive a `bounded-repeat` phase (design v3 §4). Each iteration is one committed
 * attempt on the same logical phase under an iteration-indexed expansion
 * identity; after it commits the runner reads that iteration's own output
 * evidence and lets `repeatIterationDecision` choose whether to run the next. A
 * `while-boolean` continuation is refused, not mis-driven.
 */
export async function driveRepeatPhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  const continuation = repeatContinuationInput(expansion.continuation);
  if (continuation === null) {
    return { status: "refused", runId: input.binding.runId, reason: `bounded-repeat ${phase.logicalPhaseId}: while-boolean continuation is unsupported` };
  }
  for (let index = 0; index < expansion.maximumIterations; index += 1) {
    const outcome = await driveInstance(phase.logicalPhaseId, repeatExpansionIdentity(index));
    if (outcome !== null) return outcome;
    const remaining = await repeatRemainingIsEmpty(input, phase, index, continuation);
    if (typeof remaining === "string") return { status: "refused", runId: input.binding.runId, reason: remaining };
    const decision = repeatIterationDecision({
      completedIndex: index, maximumIterations: expansion.maximumIterations,
      continuation, remainingIsEmpty: remaining, limitDisposition: expansion.limitDisposition,
    });
    if (decision.kind === "refused") return { status: "refused", runId: input.binding.runId, reason: `fan-out of ${phase.logicalPhaseId}: ${decision.reason}` };
    if (decision.kind !== "continue") return null; // converged or stopped-incomplete
  }
  return null;
}

/** Narrow the plan continuation to the two the runner drives; null = unsupported. */
function repeatContinuationInput(
  continuation: Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>["continuation"],
): RepeatContinuationInputV1 | null {
  if (continuation.kind === "fixed-count") return { kind: "fixed-count", count: continuation.count };
  if (continuation.kind === "until-empty") return { kind: "until-empty" };
  return null;
}

/** Whether one committed iteration's remaining-queue is empty (fixed-count never reads). */
async function repeatRemainingIsEmpty(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1, index: number,
  continuation: RepeatContinuationInputV1,
): Promise<boolean | string> {
  if (continuation.kind === "fixed-count") return true; // unread by the fixed-count decision
  if (input.decodeExpansionItems === undefined) return `bounded-repeat ${phase.logicalPhaseId} needs an item decoder`;
  const instance = derivePhaseInstanceId({
    manifestDigest: input.binding.manifestDigest, logicalPhaseId: phase.logicalPhaseId,
    expansionIdentity: repeatExpansionIdentity(index),
  });
  const items = await readInstanceItems(input, phase.logicalPhaseId, instance);
  return typeof items === "string" ? items : items.length === 0;
}

/** Read and decode the source phase's output evidence for a map expansion. */
async function readSourceItems(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>,
): Promise<readonly unknown[] | string> {
  const binding = phase.inputBindings.find((entry) => entry.bindingId === expansion.sourceEvidenceBinding);
  if (binding?.sourcePhaseId === undefined) return `map source binding ${expansion.sourceEvidenceBinding} is unbound`;
  const sourceInstance = derivePhaseInstanceId({
    manifestDigest: input.binding.manifestDigest, logicalPhaseId: binding.sourcePhaseId,
    expansionIdentity: singleExpansionIdentity(),
  });
  return readInstanceItems(input, phase.logicalPhaseId, sourceInstance);
}

/**
 * Read one phase instance's settled output evidence and decode it through the
 * pack's item decoder, keyed by the fanning phase's id. Shared by the map
 * fan-out (source instance) and the bounded-repeat continuation (the just-
 * committed iteration instance) — both decode a list from durable evidence.
 */
async function readInstanceItems(
  input: RunPreparationInputV1, decoderPhaseId: string,
  instancePhaseId: ReturnType<typeof derivePhaseInstanceId>,
): Promise<readonly unknown[] | string> {
  const read = await readPreparationRun(input.root, input.binding);
  if (read.status !== "ok") return "run unreadable";
  const summary = read.run.phaseSummaries.find((entry) => entry.phaseInstanceId === instancePhaseId);
  if (summary?.outputEvidenceDigest === undefined) return `phase ${decoderPhaseId} produced no output evidence`;
  const bare = summary.outputEvidenceDigest.startsWith("sha256:")
    ? summary.outputEvidenceDigest.slice("sha256:".length) : summary.outputEvidenceDigest;
  const bytes = await readPreparationEvidenceBytes(input.root,
    { workspaceId: input.binding.workspaceId, preparationId: input.binding.preparationId }, bare, MAX_SOURCE_EVIDENCE_BYTES);
  if (bytes.status !== "ok") return `source evidence ${bytes.status}`;
  return input.decodeExpansionItems!(decoderPhaseId, bytes.bytes);
}
