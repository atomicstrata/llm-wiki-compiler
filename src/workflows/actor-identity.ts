/**
 * @file src/workflows/actor-identity.ts
 * @description The best-effort CALLER identity used for run ownership (M1).
 *
 * A run records the identity that started it ({@link WorkflowRun.owner}) so EVERY
 * mutating runId-bearing op (direct or via the action surface) can refuse a DIFFERENT
 * caller. The identity is ADVISORY, not cryptographic: it is the `LLMWIKI_ACTOR`
 * environment variable when set, else the OS username. The R3 HMAC makes the recorded
 * `owner` tamper-evident on disk, but a CLI-spawning agent SETS `LLMWIKI_ACTOR`
 * freely — so this is provenance/attribution, NOT proof of identity, and not a barrier
 * against a hostile agent that simply re-uses the owner's identity. The real boundary
 * is OS-LEVEL ISOLATION (distinct OS users / a run store the agent cannot write). The
 * owner check raises the bar for honest multi-agent setups; it is not access control
 * against a fully-hostile local agent.
 */

import os from "node:os";

/** The environment variable an operator/agent sets to declare its caller identity. */
const ACTOR_ENV = "LLMWIKI_ACTOR";

/** The identity used when neither the env var nor the OS username is available. */
const UNKNOWN_ACTOR = "unknown";

/**
 * Resolve the current caller identity for run ownership (M1). Prefers a non-empty
 * `LLMWIKI_ACTOR`; falls back to the OS username; finally to a stable `"unknown"`
 * sentinel (so the field is never empty). Best-effort/advisory by design.
 *
 * @returns The caller identity string.
 */
export function currentActorIdentity(): string {
  const declared = process.env[ACTOR_ENV];
  if (typeof declared === "string" && declared.trim().length > 0) return declared.trim();
  try {
    const username = os.userInfo().username;
    if (typeof username === "string" && username.length > 0) return username;
  } catch {
    // os.userInfo() can throw when there is no passwd entry (e.g. some containers).
  }
  return UNKNOWN_ACTOR;
}
