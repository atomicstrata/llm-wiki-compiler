/**
 * @file src/commands/workflow-action.ts
 * @description Commander actions for the read-only `llmwiki workflow action`
 * discovery commands, `list` and `show`, over a profile's declared workflow
 * ACTIONS (`show` surfaces the effective permission per surface so an operator
 * sees the clamps). `run` lives in `./workflow-action-run.js`: its terminal gate
 * IO reaches the compiler-cli entry point, which discovery never needs.
 */

import * as output from "@atomicstrata/llmwiki-core/modules/utils/output";
import { listActions, showAction, type ActionDetail } from "../workflows/actions.js";

/**
 * Print each declared workflow action (id, label, workflow, operation). A project
 * that declares no actions (e.g. the default profile) prints a clear notice.
 * Read-only; always returns 0.
 *
 * @returns The process exit code (always 0).
 */
export async function workflowActionListCommand(): Promise<number> {
  const actions = await listActions(process.cwd());
  if (actions.length === 0) {
    output.status("·", "No workflow actions declared.");
    return 0;
  }
  output.header("Workflow actions");
  for (const action of actions) {
    console.log(`${action.actionId}: ${action.label}  (${action.workflow}/${action.operation})`);
  }
  return 0;
}

/** Print the effective permission per surface (so an operator sees the clamps). */
function printEffectivePermissions(detail: ActionDetail): void {
  console.log("effective permissions:");
  for (const [surface, capability] of Object.entries(detail.effectivePermissions)) {
    console.log(`  ${surface}: ${capability}`);
  }
}

/**
 * Show one declared workflow action, INCLUDING its effective permission per
 * surface — so an operator sees, e.g., that an `mcp` request for `trusted-write`
 * is effectively `staged-write`. Read-only; `UnknownActionError` propagates to the
 * cli.ts action wrapper (printed + exit 1).
 *
 * @param actionId - The declared action id to show.
 * @returns The process exit code (always 0; an unknown id throws).
 */
export async function workflowActionShowCommand(actionId: string): Promise<number> {
  const detail = await showAction(process.cwd(), actionId);
  output.header(`Workflow action ${detail.actionId}`);
  console.log(`label:     ${detail.label}`);
  console.log(`workflow:  ${detail.workflow}`);
  console.log(`operation: ${detail.operation}`);
  if (detail.gate !== undefined) console.log(`gate:      ${detail.gate}`);
  if (detail.trustGate !== undefined) console.log(`trustGate: ${detail.trustGate}`);
  printEffectivePermissions(detail);
  return 0;
}
