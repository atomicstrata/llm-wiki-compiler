/**
 * @file src/portable/index.ts
 * @description The public entry points of the portable project path:
 * {@link registerProject} and {@link openProject}.
 *
 * `openProject` is a new entry point beside `createWikiCore`; it does not
 * change it and never falls back to it. A project reference that cannot be
 * opened portably — an unregistered directory, an unknown project, an unbound
 * principal — is refused, and every operation outside the prototype vocabulary
 * answers with a typed refusal. Nothing here silently runs the legacy path.
 *
 * A caller supplies a transport credential, never a principal: the host derives
 * who is acting.
 */

import { registerLocalProject } from "./host/local-control.js";
import { openLocalProject } from "./local.js";
import type { AdapterCapabilitiesV1 } from "./contracts.js";
import type { ProjectSession } from "./project/api.js";
import type { HostModel } from "./project/runtime.js";
import { openRemoteProject } from "./remote/remote-session.js";

/** Which project to open: a local directory, or a project served by a host. */
export type ProjectSelector =
  | { localRoot: string }
  | { host: string; project: string };

/** How the caller authenticates to the host. Never a principal, role or label. */
export type TransportCredential =
  | { kind: "local-os" }
  | { kind: "host-token"; token: string }
  | { kind: "service"; serviceToken: string };

/** What `openProject` needs. */
export interface OpenProjectOptions {
  project: ProjectSelector;
  credential: TransportCredential;
  /**
   * LOCAL projects only: the model this process, acting as the local host,
   * runs a proposal under. Without it a local proposal is refused with
   * `capability_unsupported`; reading, listing and review need no model. It
   * is never sent anywhere: a hosted project's model belongs to its host, so
   * passing this with a hosted selector is a `TypeError`.
   */
  localHostModel?: HostModel;
}

/**
 * Reject a local-host model offered for a hosted project: a client never
 * chooses the model a host runs.
 *
 * @throws TypeError when `localHostModel` accompanies a hosted selector.
 */
function assertNoModelForHostedProject(options: OpenProjectOptions): void {
  if (options.localHostModel !== undefined && !("localRoot" in options.project)) {
    throw new TypeError("localHostModel applies to a local project only; a hosted project's model is configured by its host");
  }
}

/** What registering a directory reports. */
export interface ProjectRegistration {
  projectId: string;
  /** False when the directory was already registered. */
  created: boolean;
  /** What the disk path does and does not guarantee, stated rather than implied. */
  capabilities: Pick<AdapterCapabilitiesV1, "externalWriters" | "snapshotRead" | "durability" | "batchPublish">;
  /** The root requirement the registration is made under. */
  requirement: string;
}

/**
 * Register a local project directory for the portable path. This is the one
 * knowing opt-in: afterwards the project's ordinary mutations also wait while a
 * portable publication is unresolved. Its layout and legacy commands are
 * otherwise unchanged.
 */
export async function registerProject(root: string): Promise<ProjectRegistration> {
  const { record, created, requirement } = await registerLocalProject(root);
  return {
    projectId: record.projectId, created, requirement,
    capabilities: {
      externalWriters: "possible", snapshotRead: "none", durability: "crash-consistent",
      batchPublish: "journalled-cooperative",
    },
  };
}

/**
 * Open a portable project session.
 *
 * @throws PortableDenied when the project is not registered, unknown, or the
 *   credential's principal has no binding — the three are indistinguishable.
 */
export async function openProject(options: OpenProjectOptions): Promise<ProjectSession> {
  const { project, credential } = options;
  assertNoModelForHostedProject(options);
  if ("localRoot" in project) {
    if (credential.kind !== "local-os") throw new TypeError("a local project is opened with the local-os credential");
    return openLocalProject(project.localRoot, { model: options.localHostModel });
  }
  if (credential.kind === "local-os") throw new TypeError("a hosted project needs a host or service token");
  const token = credential.kind === "host-token" ? credential.token : credential.serviceToken;
  return openRemoteProject({ host: project.host, project: project.project, token });
}
