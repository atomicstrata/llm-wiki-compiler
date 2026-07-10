/**
 * @file src/workflows/local-config.ts
 * @description The CONFINED reader for the local-project workflow-authority grant.
 *
 * The receiving project's `.llmwiki/config.json` carries an OPTIONAL local knob —
 * per-surface `workflowGrants` — that can only TIGHTEN an action's authority (a
 * portable profile carries no grant). This module reads ONLY that key; it is
 * independent of, and ignores, the `review` policy block in the same file (see
 * `src/review/config.ts`).
 *
 * ## Human-gate enablement is OUT-OF-WORKSPACE (C2)
 * `enabledHumanGates` is the ONLY privilege-RAISING knob, so it must NOT live in
 * `.llmwiki/config.json` — a path the agent's own workspace can write, which let a
 * denied human-gate action self-enable. Enablement now comes from the
 * {@link ENABLED_HUMAN_GATES_ENV} environment variable. A workspace-config
 * `enabledHumanGates` is IGNORED for enablement; the workspace config is TIGHTEN-ONLY.
 *
 * HONEST trust boundary: the env var encodes OPERATOR INTENT — it raises the bar above
 * a workspace-writable knob (a CLI-spawning agent must at least be handed the env, and
 * a naive agent that only writes files cannot self-enable). It is NOT a barrier against
 * a determined agent that itself spawns the CLI: such an agent controls its own child's
 * environment and can set the var. The REAL boundary against a fully-hostile local
 * agent is OS-LEVEL ISOLATION (run the agent as a restricted user WITHOUT the
 * operator's environment, WITHOUT write access to the run store, and WITHOUT a real
 * TTY). This in-process check is defense-in-depth, not a replacement for that.
 *
 * ## The critical invariant
 * A hostile/corrupt/escaping/oversize/symlinked config can NEVER yield more than
 * `read-only`. {@link loadLocalGrant} returns:
 *  - ABSENT config (no `.llmwiki`, no file) → the surface cap (no extra local
 *    restriction; the surface cap + profile request still govern, and the cap is
 *    safe because {@link effectivePermission} mins it down anyway).
 *  - present + a valid `workflowGrants[surface]` → that value (its only role is to
 *    tighten; a too-high value is harmless because the caller mins it).
 *  - present but the surface key absent → the surface cap.
 *  - UNREADABLE / CORRUPT / OVERSIZE / SYMLINKED / ESCAPING leaf, or a
 *    `workflowGrants[surface]` that is NOT a {@link CapabilityClass} → FAIL CLOSED
 *    to `read-only` (the conservative floor, NEVER a write capability).
 *
 * ## Confinement
 * The DIR is resolved through {@link resolveExistingConfinedPrivateDir} (no-mkdir;
 * fail-closed on an escaping `.llmwiki`), NEVER a raw `path.join`. The LEAF is then
 * read through the SHARED {@link readCappedNoFollow} primitive — `O_RDONLY |
 * O_NOFOLLOW | O_NONBLOCK` (a symlinked leaf → `ELOOP`, reported unavailable;
 * `O_NONBLOCK` stops a planted FIFO from blocking the open forever, a local DoS),
 * `fstat`ed requiring a REGULAR file, and size-capped at {@link MAX_LOCAL_CONFIG_BYTES}
 * BEFORE the read — the exact discipline the run store uses for its run leaves.
 */

import path from "node:path";
import { MAX_LOCAL_CONFIG_BYTES } from "../utils/constants.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { CAPABILITY_ORDER, SURFACE_HARD_CAP } from "./authority.js";
import type { CapabilityClass, ActionSurface } from "../profile/types.js";

/**
 * The local-authority slice of `.llmwiki/config.json`. All fields OPTIONAL: a
 * config carrying neither key (e.g. a review-policy-only config) is valid and
 * imposes no local workflow restriction. Module-internal — the public readers
 * collapse it to a capability/boolean; the raw shape is not part of the API yet.
 */
interface LocalWorkflowConfig {
  /** Per-surface authority grant; only ever TIGHTENS the effective permission. */
  workflowGrants?: Partial<Record<ActionSurface, CapabilityClass>>;
}

/**
 * The OUT-OF-WORKSPACE environment variable carrying the operator's enabled human
 * gates as a comma/space-separated list of `<kind>:<id>` strings. Set in the
 * operator's shell, OUTSIDE the agent's file-WRITE reach — unlike
 * `.llmwiki/config.json`, which the agent's workspace can write.
 *
 * This encodes OPERATOR INTENT and raises the bar over a workspace-writable knob; it
 * is NOT forgery-proof against a CLI-SPAWNING agent (which controls its child's env).
 * The real boundary is OS isolation (see the file header).
 */
const ENABLED_HUMAN_GATES_ENV = "LLMWIKI_ENABLED_HUMAN_GATES";

/**
 * The conservative floor a fail-closed read collapses to. NEVER a write
 * capability: a config we cannot vouch for can grant no more than read access.
 */
const FAIL_CLOSED_GRANT: CapabilityClass = "read-only";

/** The trust-aware result of reading the local config leaf. */
type LocalConfigRead =
  | { status: "ok"; config: LocalWorkflowConfig }
  | { status: "absent" }
  | { status: "unavailable"; detail: string };

/** The `config.json` leaf inside an already-confined private dir. */
function configLeafIn(privateDir: string): string {
  return path.join(privateDir, "config.json");
}

/** True for a value that is a recognized {@link CapabilityClass}. */
function isCapabilityClass(value: unknown): value is CapabilityClass {
  return typeof value === "string" && (CAPABILITY_ORDER as readonly string[]).includes(value);
}

/** Parse config bytes into a {@link LocalWorkflowConfig}, failing closed on a non-object. */
function parseLocalConfig(raw: string): LocalConfigRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", detail: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unavailable", detail: "schema" };
  }
  return { status: "ok", config: parsed as LocalWorkflowConfig };
}

/**
 * Read `.llmwiki/config.json` into a DISCRIMINATED, trust-aware result — the
 * single confined read both {@link loadLocalGrant} and {@link localEnablesHumanGate}
 * build on. `absent` when `.llmwiki` or the leaf is missing; `unavailable` (with a
 * reason) on an escaping `.llmwiki`, a symlinked/oversize/non-regular leaf, or
 * corrupt/non-object JSON; `ok` with the parsed config otherwise. Module-internal:
 * the public readers expose a collapsed capability/boolean, not this discriminant.
 *
 * @param root - Absolute project root.
 */
async function readLocalConfig(root: string): Promise<LocalConfigRead> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { status: "unavailable", detail: "escape" };
  }
  if (privateDir === null) return { status: "absent" };
  const read = await readCappedNoFollow(configLeafIn(privateDir), MAX_LOCAL_CONFIG_BYTES);
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind === "unavailable") return { status: "unavailable", detail: "leaf" };
  return parseLocalConfig(read.body);
}

/**
 * Resolve the LOCAL authority grant for one surface. ABSENT config (or an absent
 * surface key) → the surface cap (no extra local restriction). A valid
 * `workflowGrants[surface]` → that value (its role is to tighten; the caller's
 * {@link effectivePermission} mins it with the surface cap). ANY read problem, or a
 * grant value that is not a {@link CapabilityClass}, FAILS CLOSED to `read-only`.
 *
 * @param root - Absolute project root.
 * @param surface - The surface whose grant to resolve.
 * @returns The local grant capability for the surface.
 */
export async function loadLocalGrant(root: string, surface: ActionSurface): Promise<CapabilityClass> {
  const read = await readLocalConfig(root);
  if (read.status === "absent") return SURFACE_HARD_CAP[surface];
  if (read.status === "unavailable") return FAIL_CLOSED_GRANT;
  const grant = read.config.workflowGrants?.[surface];
  if (grant === undefined) return SURFACE_HARD_CAP[surface];
  return isCapabilityClass(grant) ? grant : FAIL_CLOSED_GRANT;
}

/**
 * Parse {@link ENABLED_HUMAN_GATES_ENV} into the set of operator-enabled gate ids.
 * The value is a comma/space-separated list of `<kind>:<id>` strings; empty/whitespace
 * tokens are dropped. An unset/empty var yields an empty set (no gate enabled).
 *
 * @returns The set of `<kind>:<id>` gate strings the operator enabled out-of-band.
 */
function operatorEnabledGates(): Set<string> {
  const raw = process.env[ENABLED_HUMAN_GATES_ENV];
  if (typeof raw !== "string" || raw.length === 0) return new Set();
  return new Set(raw.split(/[\s,]+/).filter((token) => token.length > 0));
}

/**
 * Whether a given human-gate id is enabled by the OPERATOR out-of-band (C2). Reads
 * the {@link ENABLED_HUMAN_GATES_ENV} environment variable — set in the operator's
 * shell, OUTSIDE the agent's file-write reach — NOT the agent-writable
 * `.llmwiki/config.json` (whose `enabledHumanGates`, if any, is IGNORED here so an
 * agent cannot self-enable). Defaults to `false`; a gate is enabled only when the
 * env var lists it.
 *
 * @param _root - Absolute project root (unused; enablement is out-of-workspace).
 * @param gateId - The gate id (`<kind>:<id>`) to check.
 * @returns `true` only when the operator's env var lists the gate.
 */
export async function localEnablesHumanGate(_root: string, gateId: string): Promise<boolean> {
  return operatorEnabledGates().has(gateId);
}
