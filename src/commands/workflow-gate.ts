/**
 * @file src/commands/workflow-gate.ts
 * @description CLI presentation for generic workflow gate approval. Human gates
 * share the subject-verifying challenge and TTY proof; non-human gates retain
 * the existing actor validation and direct approval path.
 */

import { output } from "@atomicstrata/llmwiki-core/compiler-cli";
import { approveGate, resolveGateChallenge } from "../workflows/gate.js";
import { confirmHumanGateInteractively } from "../workflows/human-gate-confirm.js";
import { processHumanGateIo } from "./workflow-shared.js";
import type { WorkflowActorKind } from "../workflows/types.js";

const ACTOR_KINDS: readonly WorkflowActorKind[] = ["agent", "system"];

/** Options accepted by `workflow gate approve`. */
export interface WorkflowGateApproveOptions {
  actor?: string;
  actorLabel?: string;
}

/** Validate the self-assertable, non-human actor vocabulary. */
function actorKindOrExit(actor: string | undefined): WorkflowActorKind {
  const kind = actor ?? "agent";
  if (!ACTOR_KINDS.includes(kind as WorkflowActorKind)) {
    console.error(`\x1b[31mError:\x1b[0m --actor ${JSON.stringify(kind)} cannot satisfy a gate (expected agent|system; a human gate is approved via interactive confirmation)`);
    process.exit(1);
  }
  return kind as WorkflowActorKind;
}

/** Print the persisted approval result. */
function printApproved(gateId: string, run: Awaited<ReturnType<typeof approveGate>>): void {
  output.status("+", output.success(`Approved gate ${gateId} (${run.satisfiedGates.join(", ")})`));
  console.log(`currentStage: ${run.currentStage ?? "(none)"}`);
}

/** Challenge and record one subject-bound or ordinary human gate. */
async function approveHuman(
  runId: string, gateId: string, actorLabel: string | undefined, subjectDigest?: string,
): Promise<void> {
  const confirmed = await confirmHumanGateInteractively(gateId, processHumanGateIo(), subjectDigest);
  if (!confirmed) {
    console.error(`\x1b[31mError:\x1b[0m human gate ${JSON.stringify(gateId)} was not interactively confirmed; nothing approved`);
    process.exit(1);
  }
  const run = await approveGate(process.cwd(), runId, gateId, {
    actorKind: "human", actorLabel, expectedSubjectDigest: subjectDigest,
  });
  printApproved(gateId, run);
}

/** Approve the current stage's matching gate through the generic CLI surface. */
export async function workflowGateApproveCommand(
  runId: string, gateId: string, options: WorkflowGateApproveOptions,
): Promise<void> {
  const challenge = await resolveGateChallenge(process.cwd(), runId, gateId);
  if (challenge.kind === "human") {
    return approveHuman(runId, gateId, options.actorLabel, challenge.subjectDigest);
  }
  const run = await approveGate(process.cwd(), runId, gateId, {
    actorKind: actorKindOrExit(options.actor), actorLabel: options.actorLabel,
  });
  printApproved(gateId, run);
}
