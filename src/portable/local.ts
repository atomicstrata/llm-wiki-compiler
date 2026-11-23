/**
 * @file src/portable/local.ts
 * @description The local host: opening a registered project directory as a
 * portable session in the caller's own process.
 *
 * Locally the host boundary is a function call and the OS user is trusted. The
 * principal is still derived by the host — `local:<os-user>`, from the role
 * binding registration recorded in control state outside the project — and
 * every operation is still decided against that state. An unregistered
 * directory, an unknown project and an unbound user are the same answer.
 *
 * The local host's model is whatever its caller passes in. With none, a
 * proposal is refused with `capability_unsupported` before anything runs.
 */

import { randomUUID } from "node:crypto";
import type { PrincipalContext } from "./contracts.js";
import { PortableDenied } from "./errors.js";
import { assertUsableRegistration, LocalHostControl, localSubject } from "./host/local-control.js";
import { registrationMode } from "./host/control.js";
import { authorize } from "./host/policy.js";
import type { ProjectSession } from "./project/api.js";
import type { HostModel, ProjectRuntime } from "./project/runtime.js";
import { createProjectSession } from "./project/wiki-project.js";
import { DiskProjectStore, type DiskStoreOptions } from "./store/disk-store.js";

/** Options for opening a local project. The store options are test seams only. */
export interface LocalOpenOptions {
  /** The host control root; defaults to the per-user one. */
  controlRoot?: string;
  store?: DiskStoreOptions;
  /**
   * The model this local host runs a proposal under. The caller IS the local
   * host, so it supplies the model explicitly. Absent, the session still
   * reads, lists and reviews, and a proposal is refused by name: no stand-in
   * model answers, and no provider is built from the environment.
   */
  model?: HostModel;
}

/**
 * Derive the runtime of a registered local project for the OS user running this process.
 *
 * @param root - The project directory, resolved through host control state only.
 * @throws PortableDenied when the directory is not registered or the user is unbound.
 */
export async function openLocalRuntime(root: string, options: LocalOpenOptions = {}): Promise<ProjectRuntime> {
  const control = await LocalHostControl.open(options.controlRoot);
  const record = await control.projectForRoot(root);
  if (record === null || record.canonicalRoot === null) throw new PortableDenied();
  assertUsableRegistration(record, control);
  const subject = localSubject();
  const principal: PrincipalContext = {
    tenant: record.tenant, project: record.projectId, subject, actor: subject,
    observedPolicyRevision: record.policyRevision, sessionId: randomUUID(),
  };
  // The coarse check runs before any project lookup or store is opened.
  await authorize(control, principal, "project.open");
  // The store re-reads the registration at every gated step: an adoption after this open still binds this session.
  const registration = async () => {
    const current = await control.loadProject(record.projectId);
    return current === null ? "unsupported" as const : registrationMode(current);
  };
  const store = await DiskProjectStore.open(record.projectId, record.canonicalRoot, { ...options.store, registration });
  return { control, store, principal, model: options.model ?? null };
}

/**
 * Open a registered local project for the OS user running this process.
 *
 * @param root - The project directory, resolved through host control state only.
 * @throws PortableDenied when the directory is not registered or the user is unbound.
 */
export async function openLocalProject(root: string, options: LocalOpenOptions = {}): Promise<ProjectSession> {
  return createProjectSession(await openLocalRuntime(root, options));
}
