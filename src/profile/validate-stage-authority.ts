/**
 * @file Stage authority validation: executor exclusivity, output trust gates
 * and subject-bound human approval. Semantic checks follow structural validation.
 */
import type { EntityTypeDef, WorkflowStageDef } from "./types.js";
import { assert, parseGrammarGate } from "./validate-helpers.js";
import { validateHumanInputDescriptor } from "./validate-human-input.js";

/** Validate the mutually exclusive human-input and product-action contracts. */
export function validateStageExecutor(
  wf: string, stage: WorkflowStageDef, entities: Record<string, EntityTypeDef>, artifactTypes: Set<string>,
): void {
  assert(stage.productAction === undefined || /^[a-z0-9][a-z0-9.-]*$/.test(stage.productAction),
    `workflow '${wf}' stage '${stage.id}' productAction is malformed`);
  validateHumanInputDescriptor(stage.humanInput, entities, artifactTypes, `workflow '${wf}' stage '${stage.id}' humanInput`);
  assert(stage.humanInput === undefined || (stage.writes.length === 0 && (stage.artifactWrites ?? []).length === 0
    && stage.productAction === undefined),
    `workflow '${wf}' stage '${stage.id}' humanInput cannot also declare writes, artifactWrites, or productAction`);
}

/** Validate one stage gate and require a trust-gated output contract. */
export function validateStageGate(wf: string, stage: WorkflowStageDef): void {
  if (stage.gate === undefined) return;
  const kind = parseGrammarGate(stage.gate);
  assert(kind !== null, `workflow '${wf}' stage '${stage.id}' has a malformed gate '${stage.gate}'`);
  if (kind !== "trust") return;
  const producesOutput = stage.writes.length > 0 || (stage.artifactWrites ?? []).length > 0
    || stage.productAction !== undefined;
  assert(producesOutput, `workflow '${wf}' stage '${stage.id}' has a 'trust:' gate but declares no writes or artifactWrites — a trust gate is satisfiable only by a stage output`);
}

/** Validate a subject gate against one earlier artifact-producing stage. */
export function validateSubjectGate(
  wf: string, stage: WorkflowStageDef, priorStages: WorkflowStageDef[], artifactTypes: Set<string>,
): void {
  if (stage.subjectGate === undefined) return;
  assert(stage.gate?.startsWith("human:") === true,
    `workflow '${wf}' stage '${stage.id}' subjectGate requires a human gate`);
  const source = priorStages.find((prior) => prior.id === stage.subjectGate?.outputStageId);
  assert(source !== undefined,
    `workflow '${wf}' stage '${stage.id}' subjectGate outputStageId must name an earlier stage`);
  assert(artifactTypes.has(stage.subjectGate.artifactType),
    `workflow '${wf}' stage '${stage.id}' subjectGate artifactType is not declared`);
  assert(source?.artifactWrites?.includes(stage.subjectGate.artifactType) === true,
    `workflow '${wf}' stage '${stage.id}' subjectGate artifactType is not produced by its output stage`);
  assert(/^[a-z0-9][a-z0-9-]*(?:\/v[0-9]+)?$/.test(stage.subjectGate.verifierId),
    `workflow '${wf}' stage '${stage.id}' subjectGate verifierId is malformed`);
}
