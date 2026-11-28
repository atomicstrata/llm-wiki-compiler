/**
 * @file src/portable/scoped-disk/open.ts
 * @description The SDK entry points of slice S2b: explicitly adopt portable
 * format 2 for one registered directory, and open a session that also speaks
 * the disk scoped protocol — beside `openProject`, which is unchanged.
 *
 * Neither is ever implied. Opening never adopts, and adoption is a separate,
 * operator-stated act whose result says in plain words what it costs: older
 * portable-aware binaries (verified: published 1.5.0) then refuse to modify
 * the project, and there is no downgrade. A caller must state the disk scoped
 * protocol to get a `scoped` member; the version 1 session inside is exactly
 * what `openProject` returns for the same directory.
 */

import { adoptFormat2, type AdoptionResult } from "../host/format-adoption.js";
import { openLocalRuntime } from "../local.js";
import type { ProjectSession } from "../project/api.js";
import type { HostModel } from "../project/runtime.js";
import { createProjectSession } from "../project/wiki-project.js";
import { DISK_SCOPED_PROTOCOL_V2, type DiskScopedProjectV2 } from "./disk-contracts.js";
import { createDiskScopedProject } from "./disk-project.js";

/** What `openDiskScopedProject` needs: the registered directory, and the protocols the caller speaks. */
export interface OpenDiskScopedProjectOptions {
  localRoot: string;
  /** Must include `portable-scoped-disk/2`. Nothing is inferred from its absence. */
  protocols: readonly string[];
  /** The model this local host runs a scoped proposal under; absent, a proposal is refused with `capability_unsupported`. */
  localHostModel?: HostModel;
}

/** A version 1 session of a registered directory with its disk scoped surface beside it. */
export interface DiskScopedSessionV2 extends ProjectSession { scoped: DiskScopedProjectV2 }

/**
 * Open a registered directory for the local OS user with the disk scoped
 * surface. On a project that has not adopted format 2 every scoped write
 * refuses by name; the version 1 session works as it always has.
 *
 * @throws TypeError when the caller does not state the disk scoped protocol.
 * @throws PortableDenied exactly as `openProject` does.
 */
export async function openDiskScopedProject(options: OpenDiskScopedProjectOptions): Promise<DiskScopedSessionV2> {
  if (!options.protocols.includes(DISK_SCOPED_PROTOCOL_V2)) {
    throw new TypeError(`openDiskScopedProject requires the caller to state the ${DISK_SCOPED_PROTOCOL_V2} protocol`);
  }
  const runtime = await openLocalRuntime(options.localRoot, { model: options.localHostModel });
  return { ...createProjectSession(runtime), scoped: createDiskScopedProject(runtime) };
}

/**
 * Adopt portable format 2 for the registered directory at `root`, or resume an
 * interrupted adoption. Idempotent once adopted; there is no downgrade.
 *
 * @throws PortableHostError when the directory is not registered here, its
 *   registration is unsupported, or its ledger has unresolved or open work.
 */
export function adoptProjectFormat2(root: string): Promise<AdoptionResult> {
  return adoptFormat2(root);
}
