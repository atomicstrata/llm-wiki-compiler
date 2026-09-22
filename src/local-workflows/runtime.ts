/**
 * @file src/local-workflows/runtime.ts
 * @description Explicit local-engine construction against compiler-owned services.
 * Construction checks same-process core identity before any host operation. This
 * runtime binds the existing operations without a second execution algorithm or
 * persisted run format. Independent package extraction is a separate build step.
 */
import { assertLocalWorkflowCoreInstance } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { startWorkflowWithHost, type StartWorkflowRequest } from "./start-operation.js";
import { submitStageOutputWithHost, type StageOutput } from "./stage-output.js";
import type { SubmitStageOutputOptions } from "./artifact-output.js";
import { cancelWorkflowWithHost } from "./cancel.js";
import { failWorkflowWithHost } from "./fail.js";
import { resumeWorkflowWithHost } from "./resume.js";
import { advanceWorkflowWithHost } from "./advance.js";
import type { BlockingLockOptions } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { refuseWorkflowWithHost, type RefuseWorkflowOptionsV1 } from "./refuse.js";
import { adaptDryRunWithHost, adaptApplyWithHost } from "./adapt.js";
import { approveGateWithHost, resolveGateChallengeWithHost, type ApproveGateOptions } from "./gate.js";
import { mintVerifierReceiptWithHost } from "./verifier-receipt.js";
import type { HostVerifierRegistryV1 } from "./verifier-registry.js";
import { runActionWithHost } from "./run-action.js";
import type { ActionSurface } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { HumanGateIo } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { approveHumanGateWithHost } from "./approve-human-interactively.js";
import { listWorkflowsWithHost } from "./list.js";
import { showWorkflowWithHost } from "./show.js";
import { listActionsWithHost, showActionWithHost } from "./actions.js";
import { listRunEventsWithHost } from "./run-events.js";
import { writeProjectionWithHost } from "./projection.js";

/** Construct the engine over one compatible host without performing any I/O. */
export function createLocalWorkflowRuntime(host: LocalWorkflowHost) {
  assertLocalWorkflowCoreInstance(host);
  return Object.freeze({
    start: (request: StartWorkflowRequest) => startWorkflowWithHost(host, request),
    events: (root: string, runId: string) => listRunEventsWithHost(host, root, runId),
    project: (root: string, runId: string) => writeProjectionWithHost(host, root, runId),
    list: (root: string) => listWorkflowsWithHost(host, root),
    show: (root: string, workflowId: string) => showWorkflowWithHost(host, root, workflowId),
    listActions: (root: string) => listActionsWithHost(host, root),
    showAction: (root: string, actionId: string) => showActionWithHost(host, root, actionId),
    runAction: (root: string, actionId: string, inputs: Record<string, unknown>, surface: ActionSurface, io?: HumanGateIo) =>
      runActionWithHost(host, root, actionId, inputs, surface, io),
    approveHumanGateInteractively: (root: string, runId: string, gateId: string) => approveHumanGateWithHost(host, root, runId, gateId),
    mintVerifierReceipt: (root: string, runId: string, stageId: string, artifactRef: string,
      verifierId: string, registry: HostVerifierRegistryV1) =>
      mintVerifierReceiptWithHost(host, root, runId, stageId, artifactRef, verifierId, registry),
    gateChallenge: (root: string, runId: string, gateId: string) => resolveGateChallengeWithHost(host, root, runId, gateId),
    approveGate: (root: string, runId: string, gateId: string, options: ApproveGateOptions,
      lockOptions: BlockingLockOptions = {}) => approveGateWithHost(host, root, runId, gateId, options, lockOptions),
    adaptDryRun: (root: string, runId?: string) => adaptDryRunWithHost(host, root, runId),
    adaptApply: (root: string, runId: string, options?: { confirm?: boolean }) => adaptApplyWithHost(host, root, runId, options),
    status: (root: string, runId?: string) => host.history.status(root, runId),
    cancel: (root: string, runId: string) => cancelWorkflowWithHost(host, root, runId),
    refuse: (root: string, runId: string, options: RefuseWorkflowOptionsV1) => refuseWorkflowWithHost(host, root, runId, options),
    fail: (root: string, runId: string, detail: string) => failWorkflowWithHost(host, root, runId, detail),
    resume: (root: string, runId: string) => resumeWorkflowWithHost(host, root, runId),
    advance: (root: string, runId: string, options: BlockingLockOptions = {}) => advanceWorkflowWithHost(host, root, runId, options),
    submit: (root: string, runId: string, output: StageOutput, options: SubmitStageOutputOptions = {}) =>
      submitStageOutputWithHost(host, root, runId, output, options),
  });
}
