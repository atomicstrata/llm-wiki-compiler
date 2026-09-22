/**
 * @file src/local-workflows/process-definition.ts
 * @description Reads the active package's digest-bound process definition and
 * exposes only the small generic declarations core must enforce. Product stage
 * semantics remain opaque; core understands terminal-disposition rows only.
 */

import type { readLocalWorkflowProcessSource } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { isSlugSafe } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

const MAX_TERMINAL_DISPOSITIONS = 32;
const MAX_VERIFIER_IMPLEMENTATIONS = 32;
const VERIFIER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/v[0-9]+)?$/;

/** One generic mapping from a stage verifier result to a terminal reason. */
export interface TerminalDispositionV1 {
  stageId: string;
  verifierResult: string;
  reasonCode: string;
}

/** One verifier implementation pinned by the immutable process definition. */
export interface ProcessVerifierPinV1 {
  verifierId: string;
  implementationDigest: string;
}

/** Refusal raised when a process definition cannot authorize a disposition. */
class ProcessDefinitionError extends Error {
  constructor(readonly reason: string) {
    super(`process definition is ${reason}`);
    this.name = "ProcessDefinitionError";
  }
}

/** True only for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one closed terminal-disposition row. */
function parseDisposition(value: unknown): TerminalDispositionV1 {
  if (!isObject(value)) throw new ProcessDefinitionError("malformed-terminal-disposition");
  const expected = ["reasonCode", "stageId", "verifierResult"];
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new ProcessDefinitionError("malformed-terminal-disposition");
  }
  const { stageId, verifierResult, reasonCode } = value;
  if (![stageId, verifierResult, reasonCode].every((item) => typeof item === "string" && isSlugSafe(item))) {
    throw new ProcessDefinitionError("malformed-terminal-disposition");
  }
  return { stageId: stageId as string, verifierResult: verifierResult as string, reasonCode: reasonCode as string };
}

/** Parse one closed verifier pin. */
function parseVerifierPin(value: unknown): ProcessVerifierPinV1 {
  if (!isObject(value)) throw new ProcessDefinitionError("malformed-verifier-pin");
  const expected = ["implementationDigest", "verifierId"];
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new ProcessDefinitionError("malformed-verifier-pin");
  }
  const { verifierId, implementationDigest } = value;
  if (typeof verifierId !== "string" || !VERIFIER_ID_PATTERN.test(verifierId)) {
    throw new ProcessDefinitionError("malformed-verifier-pin");
  }
  if (typeof implementationDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(implementationDigest)) {
    throw new ProcessDefinitionError("malformed-verifier-pin");
  }
  return { verifierId, implementationDigest };
}

/** Read and authenticate the process-definition JSON bound to `run`. */
async function readDefinition(root: string, run: WorkflowRun,
  readSource: typeof readLocalWorkflowProcessSource): Promise<Record<string, unknown>> {
  const text = await readSource(root, run.processAuthority?.processDefinitionDigest);
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new ProcessDefinitionError("malformed");
  return parsed;
}

/** Resolve the sole terminal disposition for the run's current stage/result. */
export async function resolveTerminalDisposition(
  root: string, run: WorkflowRun, verifierResult: string,
  readSource: typeof readLocalWorkflowProcessSource,
): Promise<TerminalDispositionV1> {
  if (!isSlugSafe(verifierResult)) throw new ProcessDefinitionError("malformed-verifier-result");
  const definition = await readDefinition(root, run, readSource);
  if (!Array.isArray(definition.terminalDispositions)
    || definition.terminalDispositions.length > MAX_TERMINAL_DISPOSITIONS) {
    throw new ProcessDefinitionError("malformed-terminal-dispositions");
  }
  const matches = definition.terminalDispositions.map(parseDisposition).filter(
    (row) => row.stageId === run.currentStage && row.verifierResult === verifierResult,
  );
  if (matches.length !== 1) throw new ProcessDefinitionError("terminal-disposition-not-declared");
  return matches[0];
}

/** Resolve the sole implementation digest pinned for `verifierId`. */
export async function resolveProcessVerifierPin(
  root: string, run: WorkflowRun, verifierId: string,
  readSource: typeof readLocalWorkflowProcessSource,
): Promise<ProcessVerifierPinV1> {
  const definition = await readDefinition(root, run, readSource);
  if (!Array.isArray(definition.verifierImplementations)
    || definition.verifierImplementations.length > MAX_VERIFIER_IMPLEMENTATIONS) {
    throw new ProcessDefinitionError("malformed-verifier-pins");
  }
  const matches = definition.verifierImplementations.map(parseVerifierPin)
    .filter((pin) => pin.verifierId === verifierId);
  if (matches.length !== 1) throw new ProcessDefinitionError("verifier-not-pinned");
  return matches[0];
}
