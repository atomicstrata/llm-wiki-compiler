/**
 * @file src/local-workflows/execution-context.ts
 * @description Engine-side binding of an active core transaction to run effects.
 * These helpers carry no independent filesystem or authority implementation.
 */
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowTransaction } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { terminalRunCandidates } from "./run-policy.js";
import { maybeAutoProject, projectRun } from "./projection.js";

/** The host and transaction available while one lifecycle operation holds the lock. */
export interface WorkflowExecutionContext {
  host: LocalWorkflowHost;
  transaction: LocalWorkflowTransaction;
}

/** Bind normal persistence without opening a second mutation transaction. */
export function runWriter(context: WorkflowExecutionContext) {
  return (root: string, run: WorkflowRun) => context.host.records.write(context.transaction, root, run);
}

/** Keep terminal compaction in the engine and signed, bounded persistence in core. */
export function terminalRunWriter(context: WorkflowExecutionContext) {
  return (root: string, run: WorkflowRun) =>
    context.host.records.writeCandidates(context.transaction, root, terminalRunCandidates(run));
}

/** Already-bound persistence functions; neither owns a store or acquires a lock. */
export type RunWriter = ReturnType<typeof runWriter>;
export type TerminalRunWriter = ReturnType<typeof terminalRunWriter>;

/** Refresh derived text after lock release without turning projection failure into lost mutation. */
export function projectWithHost(host: LocalWorkflowHost, root: string, run: WorkflowRun): Promise<void> {
  return maybeAutoProject(root, run,
    (projectRoot, record) => host.projections.write(projectRoot, record.workflowId, projectRun(record)));
}
