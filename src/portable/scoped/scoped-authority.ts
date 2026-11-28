/**
 * @file src/portable/scoped/scoped-authority.ts
 * @description Who may use the scoped path, decided from ONE load of current
 * host state every time it is asked.
 *
 * Version 1's coarse check looks the principal's verbs up by project id. The
 * scoped path also requires the session, the control record and the store to
 * name the same tenant and project — the S1 binding rule — and it asks again
 * inside the gate at every effect, before any proposal or approval byte is
 * read. A caller who is not bound learns exactly what an absent project tells
 * them: nothing.
 */

import type { LabelSet, Permission } from "../contracts.js";
import { PortableDenied } from "../errors.js";
import type { ProjectControlRecord } from "../host/control.js";
import { isCleared } from "../host/policy.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { boundEntitlement } from "../scale/paged-reads.js";

/** What one bound, authorized load of host state established. */
export interface ScopedAuthority { record: ProjectControlRecord; clearances: LabelSet }

/** The verbs each scoped act needs. */
export const SCOPED_VERBS = {
  propose: ["compile.propose", "model.invoke", "source.read", "page.read"],
  read: ["candidate.read"],
  approve: ["candidate.approve", "candidate.read"],
  apply: ["publication.apply"],
  sourceStatus: ["source.read"],
  view: ["page.read"],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * One load of the current control record: the session, the record and the
 * store must name the same tenant and project, and the acting identity must
 * hold every verb — and, when given, clearance for `labels`.
 *
 * @returns `null` when the caller is not admitted now.
 */
export async function scopedAuthority(
  runtime: ProjectRuntime, verbs: readonly Permission[], labels: LabelSet = [],
): Promise<ScopedAuthority | null> {
  const { control, principal } = runtime;
  const record = await control.loadProject(principal.project);
  const held = boundEntitlement(runtime, record);
  const isAdmitted = held !== null && verbs.every((verb) => held.permissions.has(verb)) && isCleared(held.clearances, labels);
  // The true reason goes to the audit sink and nowhere else.
  control.audit({ kind: "decision", project: principal.project, subject: principal.actor, permissions: verbs, allowed: isAdmitted });
  return isAdmitted && record !== null && held !== null ? { record, clearances: held.clearances } : null;
}

/**
 * As {@link scopedAuthority}, failing the way an absent project fails.
 *
 * @throws PortableDenied when the caller is not admitted now.
 */
export async function requireScopedAuthority(
  runtime: ProjectRuntime, verbs: readonly Permission[], labels: LabelSet = [],
): Promise<ScopedAuthority> {
  const authority = await scopedAuthority(runtime, verbs, labels);
  if (authority === null) throw new PortableDenied();
  return authority;
}
