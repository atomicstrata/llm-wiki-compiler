/**
 * @file src/viewer/workflow-run-facts.ts
 * @description Validates and snapshots product-supplied live stage facts before
 * they enter the generic viewer. Verified rows may carry bounded provenance and
 * fact panels; every failure remains recorded-only with a stable visible reason.
 */

import type {
  LiveStageProjectionProvider, LiveStageProjectionResult, RunProjectionAnchor,
  LiveProjectionOutcome, StageProjection, StageVerificationFailureV1, VerifiedStageFactsV1,
} from "./workflow-run-projection.js";
import type { WorkflowRun } from "../workflow-history/types.js";
import { normalizeVerifiedFacts, type NormalizedFacts } from "./workflow-run-provider-facts.js";

const MAX_STAGE_STRING_LEN = 4_000;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const REASON_CATEGORIES = new Set(["stale-or-invalid", "unavailable", "timed-out"]);

class ProjectionTimeoutError extends Error {}

/** A non-empty, length-bounded string. */
function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STAGE_STRING_LEN;
}

/** Insert one verified snapshot when it names one unused known stage. */
function insertFact(
  raw: VerifiedStageFactsV1, known: ReadonlySet<string>, facts: Map<string, NormalizedFacts>,
): boolean {
  const row = normalizeVerifiedFacts(raw);
  if (row === null) return false;
  if (!known.has(row.stageId) || facts.has(row.stageId)) return false;
  facts.set(row.stageId, row);
  return true;
}

/** Insert one failure when it names one otherwise undescribed known stage. */
function insertFailure(
  raw: StageVerificationFailureV1, known: ReadonlySet<string>, facts: ReadonlyMap<string, NormalizedFacts>,
  failures: Map<string, StageVerificationFailureV1>,
): boolean {
  const row = normalizeFailure(raw);
  if (row === null) return false;
  if (!known.has(row.stageId) || facts.has(row.stageId) || failures.has(row.stageId)) return false;
  failures.set(row.stageId, row);
  return true;
}

/** Snapshot one product-declared recorded-only reason. */
function normalizeFailure(value: StageVerificationFailureV1): StageVerificationFailureV1 | null {
  const stageId = value.stageId, category = value.category, code = value.code;
  if (!isBoundedString(stageId) || typeof category !== "string" || !REASON_CATEGORIES.has(category)
    || typeof code !== "string" || !REASON_CODE.test(code)) return null;
  return { stageId, category: category as StageVerificationFailureV1["category"], code };
}

/** Validate provider rows and reject unknown or multiply-described stages. */
function normalizeRows(
  result: LiveStageProjectionResult, known: ReadonlySet<string>,
): { facts: Map<string, NormalizedFacts>; failures: Map<string, StageVerificationFailureV1> } | null {
  if (!Array.isArray(result.stages) || (result.failures !== undefined && !Array.isArray(result.failures))) return null;
  const facts = new Map<string, NormalizedFacts>(), failures = new Map<string, StageVerificationFailureV1>();
  for (const raw of [...result.stages]) {
    if (!insertFact(raw, known, facts)) return null;
  }
  for (const raw of [...(result.failures ?? [])]) {
    if (!insertFailure(raw, known, facts, failures)) return null;
  }
  return { facts, failures };
}

/** Upgrade one row with already-snapshotted verified facts. */
function verifiedRow(row: StageProjection, facts: NormalizedFacts): StageProjection {
  return { stageId: row.stageId, status: row.status,
    ...(row.gate === undefined ? {} : { gate: row.gate }),
    ...(row.outputRef === undefined ? {} : { outputRef: row.outputRef }),
    verification: "verified", summary: facts.summary,
    appliedTargets: facts.appliedTargets, evidenceDigests: facts.evidenceDigests,
    ...(facts.groundedRefs === undefined ? {} : { groundedRefs: facts.groundedRefs }),
    ...(facts.pdfRef === undefined ? {} : { pdfRef: facts.pdfRef }),
    ...(facts.experimentState === undefined ? {} : { experimentState: facts.experimentState }),
    ...(facts.factPanel === undefined ? {} : { factPanel: facts.factPanel }) };
}

/** Attach one stable reason without allowing fact-shaped fields onto the row. */
function failedRow(row: StageProjection, reason: Omit<StageVerificationFailureV1, "stageId">): StageProjection {
  return { stageId: row.stageId, status: row.status,
    ...(row.gate === undefined ? {} : { gate: row.gate }),
    ...(row.outputRef === undefined ? {} : { outputRef: row.outputRef }),
    verification: "recorded-only", verificationReason: reason };
}

/** Apply one reason to every recorded stage. */
function failAll(rows: readonly StageProjection[], category: StageVerificationFailureV1["category"], code: string) {
  return rows.map((row) => failedRow(row, { category, code }));
}

/** Await a provider only until the local route deadline. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProjectionTimeoutError()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Verify the result identity against the frozen request anchor. */
function bindsAnchor(result: LiveStageProjectionResult, run: WorkflowRun, anchor: RunProjectionAnchor): boolean {
  return result.workflowId === run.workflowId && result.runId === run.runId
    && result.stateVersion === anchor.stateVersion && result.profileDigest === anchor.profileDigest;
}

/** Apply an untrusted live provider, preserving fail-closed recorded-only rows. */
export async function applyLiveStageProvider(
  recorded: readonly StageProjection[], provider: LiveStageProjectionProvider,
  root: string, run: WorkflowRun, anchor: RunProjectionAnchor, timeoutMs: number,
): Promise<{ readonly stages: readonly StageProjection[]; readonly live: LiveProjectionOutcome }> {
  try {
    const sealed = Object.freeze({ stateVersion: anchor.stateVersion, profileDigest: anchor.profileDigest });
    const result = await withTimeout(provider(root, run.workflowId, run.runId, sealed), timeoutMs);
    if (!bindsAnchor(result, run, anchor)) return {
      stages: failAll(recorded, "stale-or-invalid", "authority-drift"), live: { outcome: "degraded" },
    };
    const normalized = normalizeRows(result, new Set(recorded.map((row) => row.stageId)));
    if (normalized === null) return {
      stages: failAll(recorded, "stale-or-invalid", "malformed-projection"), live: { outcome: "degraded" },
    };
    const stages = recorded.map((row) => {
      const facts = normalized.facts.get(row.stageId);
      if (facts !== undefined) return verifiedRow(row, facts);
      const failure = normalized.failures.get(row.stageId);
      return failure === undefined ? row : failedRow(row, {
        category: failure.category, code: failure.code,
      });
    });
    return { stages, live: { outcome: "applied" } };
  } catch (error) {
    if (error instanceof ProjectionTimeoutError) return {
      stages: failAll(recorded, "timed-out", "verification-timeout"),
      live: { outcome: "timed-out", timeoutMs },
    };
    return {
      stages: failAll(recorded, "unavailable", "verification-unavailable"), live: { outcome: "degraded" },
    };
  }
}
