/**
 * @file src/local-workflow-host/host-contract.ts
 * @description Version-locked compiler services used by local run creation.
 * The engine receives named domain capabilities, not a Wiki facade, filesystem
 * adapter, approval callback, or unrestricted dependency lookup function.
 */
import type { loadProfile } from "../profile/load.js";
import type { resolveWorkflowProcessAuthority } from "../workflow-history/process-authority.js";
import type { readRun, listRuns, runExists, resolveRunId } from "../workflow-history/store.js";
import type { workflowStatus } from "../workflow-history/status.js";
import type { WorkflowRun } from "../workflow-history/types.js";
import type { LocalWorkflowTransactions, LocalWorkflowTransaction } from "./contracts.js";
import type { PlanResult, PlannedMutation } from "../trust/planner.js";
import type { ApplyResult } from "../trust/apply-result.js";
import type { LocalWorkflowPageIntent } from "./page-operations.js";
import type { assertCurrentWorkflowProcessAuthority } from "../workflow-history/process-authority.js";
import type { writeLocalWorkflowProjection } from "./projection.js";
import type { isTrustedWriteGranted } from "../trust/trusted-write.js";
import type { LocalWorkflowObservations } from "./observations.js";
import type { LocalWorkflowDomainMutation } from "./domain-effects.js";
import type { previewLifecycleLocked } from "../trust/lifecycle-apply.js";
import type { loadLocalGrant, localEnablesHumanGate } from "./local-config.js";
import type { workflowStatusForWorkflow } from "../workflow-history/status.js";
import type { confirmHumanGateInteractively } from "./human-gate-confirm.js";
import type { processTerminalLineIo } from "../utils/terminal-line.js";

/** Initial executable host boundary, expanded only as engine operations are moved. */
export interface LocalWorkflowHost extends LocalWorkflowTransactions {
  readonly terminal: {
    readonly confirmHumanGate: typeof confirmHumanGateInteractively;
    readonly processIo: typeof processTerminalLineIo;
  };
  readonly domain: {
    previewLifecycle(transaction: LocalWorkflowTransaction, ...args: Parameters<typeof previewLifecycleLocked>): ReturnType<typeof previewLifecycleLocked>;
    apply(transaction: LocalWorkflowTransaction, root: string, planned: LocalWorkflowDomainMutation[]): Promise<ApplyResult[]>;
  };
  readonly projections: { readonly write: typeof writeLocalWorkflowProjection };
  readonly authority: {
    readonly isTrustedWriteGranted: typeof isTrustedWriteGranted;
    readonly localGrant: typeof loadLocalGrant;
    readonly humanGateEnabled: typeof localEnablesHumanGate;
  };
  readonly observations: LocalWorkflowObservations;
  readonly profiles: {
    readonly load: typeof loadProfile;
    readonly resolveProcessAuthority: typeof resolveWorkflowProcessAuthority;
    readonly assertProcessAuthority: typeof assertCurrentWorkflowProcessAuthority;
  };
  readonly history: {
    readonly read: typeof readRun;
    readonly resolve: typeof resolveRunId;
    readonly list: typeof listRuns;
    readonly exists: typeof runExists;
    readonly status: typeof workflowStatus;
    readonly statusForWorkflow: typeof workflowStatusForWorkflow;
  };
  readonly records: {
    write(transaction: LocalWorkflowTransaction, root: string, run: WorkflowRun): Promise<void>;
    writeCandidates(transaction: LocalWorkflowTransaction, root: string, candidates: Iterable<WorkflowRun>): Promise<WorkflowRun>;
  };
  readonly pages: {
    plan(transaction: LocalWorkflowTransaction, root: string, output: LocalWorkflowPageIntent): Promise<PlanResult>;
    validate(transaction: LocalWorkflowTransaction, root: string, output: LocalWorkflowPageIntent): Promise<void>;
    apply(transaction: LocalWorkflowTransaction, root: string, planned: PlannedMutation[]): Promise<ApplyResult[]>;
  };
}
