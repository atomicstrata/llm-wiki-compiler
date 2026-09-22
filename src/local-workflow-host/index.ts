/**
 * @file src/local-workflow-host/index.ts
 * @description Compiler assembly of the local workflow integration host.
 * Construction performs no I/O or grant creation. Reads remain passive; record
 * persistence requires this host's live, root-bound mutation transaction.
 */
import { loadProfile } from "../profile/load.js";
import { resolveWorkflowProcessAuthority, assertCurrentWorkflowProcessAuthority } from "../workflow-history/process-authority.js";
import { readRun, listRuns, runExists, resolveRunId } from "../workflow-history/store.js";
import { workflowStatus, workflowStatusForWorkflow } from "../workflow-history/status.js";
import { writeRun, writeRunCandidates } from "./run-store.js";
import { createLocalWorkflowTransactionScope } from "./transactions.js";
import type { LocalWorkflowHost } from "./host-contract.js";
import { planLocalWorkflowPage, validateLocalWorkflowPage, applyLocalWorkflowPage } from "./page-operations.js";
import { writeLocalWorkflowProjection } from "./projection.js";
import { isTrustedWriteGranted } from "../trust/trusted-write.js";
import { createLocalWorkflowObservations } from "./observations.js";
import { applyLocalWorkflowDomainEffects } from "./domain-effects.js";
import { previewLifecycleLocked } from "../trust/lifecycle-apply.js";
import { loadLocalGrant, localEnablesHumanGate } from "./local-config.js";
import { confirmHumanGateInteractively } from "./human-gate-confirm.js";
import { processTerminalLineIo } from "../utils/terminal-line.js";

/** Assemble immutable method groups around one private transaction owner. */
export function createLocalWorkflowHost(): LocalWorkflowHost {
  const scope = createLocalWorkflowTransactionScope();
  return Object.freeze({
    ...scope.transactions,
    terminal: Object.freeze({ confirmHumanGate: confirmHumanGateInteractively, processIo: processTerminalLineIo }),
    domain: Object.freeze({ apply: (transaction, root, planned) =>
      scope.runEffect(transaction, root, () => applyLocalWorkflowDomainEffects(root, planned)),
      previewLifecycle: (transaction, root, input) => scope.runEffect(transaction, root, () => previewLifecycleLocked(root, input)),
    } satisfies LocalWorkflowHost["domain"]),
    projections: Object.freeze({ write: writeLocalWorkflowProjection }),
    authority: Object.freeze({ isTrustedWriteGranted, localGrant: loadLocalGrant, humanGateEnabled: localEnablesHumanGate }),
    observations: createLocalWorkflowObservations(),
    profiles: Object.freeze({ load: loadProfile, resolveProcessAuthority: resolveWorkflowProcessAuthority,
      assertProcessAuthority: assertCurrentWorkflowProcessAuthority }),
    history: Object.freeze({ read: readRun, resolve: resolveRunId, list: listRuns, exists: runExists,
      status: workflowStatus, statusForWorkflow: workflowStatusForWorkflow }),
    records: Object.freeze({
      write: (transaction, root, run) => scope.runEffect(transaction, root, () => writeRun(root, run)),
      writeCandidates: (transaction, root, candidates) => scope.runEffect(transaction, root, () => writeRunCandidates(root, candidates)),
    } satisfies LocalWorkflowHost["records"]),
    pages: Object.freeze({
      plan: (transaction, root, output) => scope.runEffect(transaction, root, () => planLocalWorkflowPage(root, output)),
      validate: (transaction, root, output) => scope.runEffect(transaction, root, () => validateLocalWorkflowPage(root, output)),
      apply: (transaction, root, planned) => scope.runEffect(transaction, root, () => applyLocalWorkflowPage(root, planned)),
    } satisfies LocalWorkflowHost["pages"]),
  });
}
