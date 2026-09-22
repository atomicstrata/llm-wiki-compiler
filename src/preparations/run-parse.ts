/**
 * @file src/preparations/run-parse.ts
 * @description Bounded, duplicate-key-free loader for the exact version-one
 * preparation-run grammar (design sections 12.2, 12.3, 13.2, 14). It rebuilds
 * allowlisted DTOs, verifies genesis, sequence, hash chain, legal state edges,
 * effect-outcome safety, terminal rules, and whole-record shape before any
 * caller can trust run state. Integrity (the HMAC) is checked by the run store
 * against the current preparation key; this loader proves everything else.
 */

import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { array, count, exact, record, textValue, unique } from "../operation-bundles/manifest-values.js";
import {
  MAX_EVIDENCE_REFS_PER_RUN, MAX_PHASE_INSTANCES_PER_RUN,
  MAX_PREPARATION_RUN_BYTES, MAX_TRANSITIONS_PER_RUN,
} from "./constants.js";
import { assertPreparationId, assertPreparationRunId } from "./ids.js";
import { assertWorkspaceId } from "./paths.js";
import { preparationRunBindingMatches } from "./run-integrity.js";
import {
  canonicalTime, parseBrokerSummary, parseCompleteness, parseEffectSummary,
  parseEvidence, parseExecutionOwner, parseGateProof, parseHandoff, parseNotice,
  parsePhaseSummary, parseResidual, parseTransition, parseWarning, runDigest,
  runState,
} from "./run-parse-helpers.js";
import { validatePreparationRun } from "./run-validation.js";
import type { JsonRecord } from "../operation-bundles/manifest-values.js";
import type { PreparationRunBinding, PreparationRunV1 } from "./run-types.js";

const TOP_KEYS = [
  "schemaVersion", "runId", "preparationId", "manifestDigest", "workspaceId",
  "keyEpochId", "state", "stateVersion", "controlTransitionAllowance",
  "phaseSummaries", "gateProofs", "brokerRequestSummaries", "effectSummaries",
  "evidenceRefs", "completeness", "completionWarnings", "notices",
  "residualFindings", "transitions", "createdAt", "updatedAt", "integrity",
] as const;
const TOP_OPTIONAL = ["executionOwner", "handoff", "supersededByPreparationId"] as const;
const HMAC = /^[0-9a-f]{64}$/;

/** Rebuild and validate one complete version-one preparation run. */
export function parsePreparationRun(text: string, binding?: PreparationRunBinding): PreparationRunV1 {
  const root = record(parseBoundedUniqueJson(text, MAX_PREPARATION_RUN_BYTES), "preparation run");
  exact(root, TOP_KEYS, TOP_OPTIONAL);
  if (root.schemaVersion !== 1) throw new Error("preparation run schemaVersion must be 1");
  const run = rebuildRun(root);
  validatePreparationRun(run);
  if (binding !== undefined && !preparationRunBindingMatches(run, binding)) {
    throw new Error("preparation run binding mismatch");
  }
  return run;
}

/** Rebuild the top-level run fields without retaining caller-owned objects. */
function rebuildRun(root: JsonRecord): PreparationRunV1 {
  const runId = assertPreparationRunId(root.runId);
  const integrity = textValue(root.integrity, "integrity", 64);
  if (!HMAC.test(integrity)) throw new Error("integrity must be lowercase HMAC-SHA256");
  return {
    schemaVersion: 1, runId, preparationId: assertPreparationId(root.preparationId),
    manifestDigest: runDigest(root.manifestDigest, "manifestDigest"),
    workspaceId: assertWorkspaceId(root.workspaceId), keyEpochId: runDigest(root.keyEpochId, "keyEpochId"),
    state: runState(root.state), stateVersion: count(root.stateVersion, "stateVersion"),
    controlTransitionAllowance: positiveCount(root.controlTransitionAllowance, "controlTransitionAllowance"),
    ...rebuildSummaries(root, runId),
    completeness: parseCompleteness(root.completeness),
    completionWarnings: array(root.completionWarnings, "completionWarnings", MAX_PHASE_INSTANCES_PER_RUN).map(parseWarning),
    notices: array(root.notices, "notices", MAX_PHASE_INSTANCES_PER_RUN).map(parseNotice),
    residualFindings: array(root.residualFindings, "residualFindings", MAX_PHASE_INSTANCES_PER_RUN).map(parseResidual),
    transitions: array(root.transitions, "transitions", MAX_TRANSITIONS_PER_RUN).map((item) => parseTransition(item, runId)),
    ...rebuildOptions(root, runId),
    createdAt: canonicalTime(root.createdAt, "createdAt"), updatedAt: canonicalTime(root.updatedAt, "updatedAt"),
    integrity,
  };
}

/** Rebuild the fixed-shape summary arrays with exact uniqueness. */
function rebuildSummaries(root: JsonRecord, runId: ReturnType<typeof assertPreparationRunId>) {
  return {
    phaseSummaries: unique(array(root.phaseSummaries, "phaseSummaries", MAX_PHASE_INSTANCES_PER_RUN).map(parsePhaseSummary), "phaseInstanceId", "phaseSummaries"),
    gateProofs: unique(array(root.gateProofs, "gateProofs", MAX_TRANSITIONS_PER_RUN).map((item) => parseGateProof(item, runId)), "gateProofId", "gateProofs"),
    brokerRequestSummaries: unique(array(root.brokerRequestSummaries, "brokerRequestSummaries", MAX_TRANSITIONS_PER_RUN).map(parseBrokerSummary), "brokerRequestId", "brokerRequestSummaries"),
    effectSummaries: array(root.effectSummaries, "effectSummaries", MAX_TRANSITIONS_PER_RUN).map(parseEffectSummary),
    evidenceRefs: array(root.evidenceRefs, "evidenceRefs", MAX_EVIDENCE_REFS_PER_RUN).map(parseEvidence),
  };
}

/** Rebuild the optional execution-owner, handoff, and supersession fields. */
function rebuildOptions(root: JsonRecord, runId: ReturnType<typeof assertPreparationRunId>) {
  const executionOwner = root.executionOwner === undefined ? undefined : parseExecutionOwner(root.executionOwner);
  const handoff = root.handoff === undefined ? undefined : parseHandoff(root.handoff, runId);
  const supersededByPreparationId = root.supersededByPreparationId === undefined
    ? undefined : assertPreparationId(root.supersededByPreparationId);
  return {
    ...(executionOwner === undefined ? {} : { executionOwner }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(supersededByPreparationId === undefined ? {} : { supersededByPreparationId }),
  };
}

/** Parse one required positive safe-integer count. */
function positiveCount(value: unknown, label: string): number {
  const parsed = count(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}
