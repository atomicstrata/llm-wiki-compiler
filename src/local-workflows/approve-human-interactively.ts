/**
 * @file Core-owned public human approval entry point. Couples the displayed
 * subject and process TTY token proof to the internal, under-lock approval.
 */
import { approveGateWithHost, resolveGateChallengeWithHost } from "./gate.js";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { currentActorIdentity } from "./actor-identity.js";

/** Use host-owned terminal proof and bind approval to the exact displayed subject. */
export async function approveHumanGateWithHost(host: LocalWorkflowHost, root: string, runId: string, gateId: string) {
  const io = host.terminal.processIo();
  if (!io.stdinIsTty || !io.stdoutIsTty) throw new Error("human approval requires an interactive TTY");
  const challenge = await resolveGateChallengeWithHost(host, root, runId, gateId);
  if (challenge.kind !== "human") throw new Error("gate is not a human gate");
  if (!await host.terminal.confirmHumanGate(gateId, io, challenge.subjectDigest)) {
    throw new Error("human gate was not interactively confirmed");
  }
  return approveGateWithHost(host, root, runId, gateId, {
    actorKind: "human", actorLabel: currentActorIdentity(), expectedSubjectDigest: challenge.subjectDigest,
  });
}
