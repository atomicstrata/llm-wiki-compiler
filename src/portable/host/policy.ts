/**
 * @file src/portable/host/policy.ts
 * @description The policy decision point: default deny, decided from CURRENT
 * host control state on every call.
 *
 * A session carries who the caller is, never what they may do. Each decision
 * looks the principal up again, so a role removed mid-session is gone at the
 * next call. A denial throws {@link PortableDenied}, which is the same failure
 * as "no such project": the reason is written to the audit sink and nowhere else.
 */

import type { LabelSet, Permission, PrincipalContext } from "../contracts.js";
import { PortableDenied } from "../errors.js";
import { ROLE_PERMISSIONS, type HostControl, type ProjectControlRecord } from "./control.js";

/** Subjects that authenticate as a service rather than a person. */
const SERVICE_PREFIX = "service:";

/** What a subject currently holds in one project. */
export interface Entitlement {
  permissions: ReadonlySet<Permission>;
  clearances: LabelSet;
  policyRevision: number;
}

/** The permissions `subject` holds right now, from bindings or its own service grant. */
function currentPermissions(record: ProjectControlRecord, subject: string): Set<Permission> {
  if (subject.startsWith(SERVICE_PREFIX)) {
    const grant = record.serviceGrants.find((entry) => entry.service === subject);
    return new Set(grant?.permissions ?? []);
  }
  const roles = record.bindings.find((entry) => entry.subject === subject)?.roles ?? [];
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

/** What `subject` holds in `record`. Any binding clears the single project compartment. */
export function entitlementOf(record: ProjectControlRecord, subject: string): Entitlement {
  const permissions = currentPermissions(record, subject);
  const clearances = permissions.size > 0 ? [record.compartment] : [];
  return { permissions, clearances, policyRevision: record.policyRevision };
}

/** True when every label is within the clearances. */
export function isCleared(clearances: LabelSet, labels: LabelSet): boolean {
  return labels.every((label) => clearances.includes(label));
}

/**
 * The coarse (tenant, project, verb) check, from host state alone. It runs
 * before any project lookup, so an unbound caller learns nothing.
 *
 * @returns The project's current record, for the caller's next step.
 * @throws PortableDenied when the project is unknown or the verb is not held.
 */
export async function authorize(
  control: HostControl, principal: PrincipalContext, permission: Permission, subject = principal.actor,
): Promise<ProjectControlRecord> {
  const record = await control.loadProject(principal.project);
  const allowed = record !== null && entitlementOf(record, subject).permissions.has(permission);
  control.audit({ kind: "decision", project: principal.project, subject, permission, allowed });
  if (!allowed || record === null) throw new PortableDenied();
  return record;
}

/** The object check: the verb AND clearance for the object's host-assigned labels. */
export async function isVisible(
  control: HostControl, principal: PrincipalContext, permission: Permission, labels: LabelSet,
): Promise<boolean> {
  const record = await control.loadProject(principal.project);
  if (record === null) return false;
  const held = entitlementOf(record, principal.actor);
  return held.permissions.has(permission) && isCleared(held.clearances, labels);
}
