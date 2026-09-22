/**
 * @file src/local-workflows/actions.ts
 * @description The read-only workflow-ACTION discovery operations (`list`/`show`).
 *
 * Surfaces the `workflowActions` declared in the active profile. `listActions`
 * projects each declared action to a lightweight summary; `showAction` resolves
 * one declared action and computes its EFFECTIVE permission per surface — the
 * FIRST consumer of the authority model:
 *
 *   effectivePermissions[surface] =
 *     effectivePermission(def.permissions[surface], loadLocalGrant(root, surface), surface)
 *     = min(profile request, local grant, surface hard cap)
 *
 * so a portable profile can never RAISE authority (an `mcp` request for
 * `trusted-write` clamps to the `staged-write` surface cap; a local config can
 * only tighten further). Both are pure reads: they load the profile (+ the
 * confined local config) and project it, creating nothing and taking no lock.
 * A default-profile project (which declares no actions) yields `[]`. An
 * undeclared id is resolved by an OWN-property check (never the prototype chain)
 * and fails closed with {@link UnknownActionError}.
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { effectivePermission, SURFACE_HARD_CAP } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { UnknownActionError } from "./errors.js";
import { actionDefForPresentation } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { CapabilityClass, ActionSurface, ActionInputField, WorkflowActionDef, ProfilePack } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** The declared {@link ActionSurface} values, derived from the surface-cap keys. */
const ACTION_SURFACES = Object.keys(SURFACE_HARD_CAP) as ActionSurface[];

/** A declared workflow action surfaced to the `list` operation. */
export interface ActionSummary {
  /** The slug-safe dotted id (`<domain>.<action>`) of the declared action. */
  actionId: string;
  /** The action's human-readable label. */
  label: string;
  /** The declared workflow the action operates on. */
  workflow: string;
  /** The workflow operation the action resolves to (`start`/`advance`/…). */
  operation: string;
}

/** A declared workflow action with its full detail + effective per-surface permission. */
export interface ActionDetail extends ActionSummary {
  /** The action's declarative input schema, when declared. */
  inputSchema?: Record<string, ActionInputField>;
  /** A `human:`/`agent:` gate this action satisfies, when declared. */
  gate?: string;
  /** A `trust:` gate this action's write must pass, when declared. */
  trustGate?: string;
  /** The EFFECTIVE permission per surface = min(request, local grant, surface cap). */
  effectivePermissions: Record<ActionSurface, CapabilityClass>;
}

/** Project a declared action def to its lightweight {@link ActionSummary}. */
function toSummary(actionId: string, def: WorkflowActionDef): ActionSummary {
  return { actionId, label: def.label, workflow: def.workflow, operation: def.operation };
}

/**
 * Resolve a declared action by an OWN-property check (never the prototype chain),
 * so an undeclared id — including a prototype-chain id like `"constructor"` —
 * fails closed with {@link UnknownActionError}. The single action-lookup primitive
 * shared by every action surface (discovery + execution), so the fail-closed
 * resolution rule lives in exactly one place.
 *
 * @param profile - The active profile carrying the optional `workflowActions`.
 * @param actionId - The candidate action id (possibly attacker-controlled).
 * @returns The declared action def for `actionId`.
 * @throws {UnknownActionError} When `actionId` is not a declared OWN action key.
 */
export function lookupAction(profile: ProfilePack, actionId: string): WorkflowActionDef {
  const actions = profile.workflowActions ?? {};
  if (!Object.hasOwn(actions, actionId)) throw new UnknownActionError(actionId);
  return actions[actionId];
}

/** Discover actions without loading an independent set of compiler services. */
export async function listActionsWithHost(host: LocalWorkflowHost, root: string): Promise<ActionSummary[]> {
  const { profile } = await host.profiles.load(root);
  const actions = profile.workflowActions ?? {};
  return Object.entries(actions)
    .map(([actionId, def]) => toSummary(actionId, actionDefForPresentation(profile, def)))
    .sort((a, b) => a.actionId.localeCompare(b.actionId));
}

/**
 * Compute the effective permission per surface for one declared action:
 * `min(def.permissions[surface], localGrant(surface), surfaceHardCap[surface])`.
 * The local grant is read once per surface through the confined local-config
 * reader, so a local `.llmwiki/config.json` can only TIGHTEN the result.
 *
 * @param root - Absolute project root.
 * @param def - The declared action def carrying the per-surface requests.
 * @returns The effective per-surface permission map.
 */
async function computeEffectivePermissions(
  host: LocalWorkflowHost,
  root: string,
  def: WorkflowActionDef,
): Promise<Record<ActionSurface, CapabilityClass>> {
  const entries = await Promise.all(
    ACTION_SURFACES.map(async (surface): Promise<[ActionSurface, CapabilityClass]> => {
      const grant = await host.authority.localGrant(root, surface);
      return [surface, effectivePermission(def.permissions[surface], grant, surface)];
    }),
  );
  return Object.fromEntries(entries) as Record<ActionSurface, CapabilityClass>;
}

/** Show a declaration with the same host's per-surface local grant observations. */
export async function showActionWithHost(host: LocalWorkflowHost, root: string, actionId: string): Promise<ActionDetail> {
  const { profile } = await host.profiles.load(root);
  const def = actionDefForPresentation(profile, lookupAction(profile, actionId));
  const effectivePermissions = await computeEffectivePermissions(host, root, def);
  return {
    ...toSummary(actionId, def),
    ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}),
    ...(def.gate !== undefined ? { gate: def.gate } : {}),
    ...(def.trustGate !== undefined ? { trustGate: def.trustGate } : {}),
    effectivePermissions,
  };
}
