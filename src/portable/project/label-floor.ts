/**
 * @file src/portable/project/label-floor.ts
 * @description The label floor of a write on a store that retains one: the
 * labels a new binding of a path may never drop below.
 *
 * A registered directory that adopted format 2 retains each path's latest
 * binding, whatever bytes it bound. A legacy writer can replace those bytes
 * without a binding, and a portable write can replace them with new ones; in
 * neither case may the path's classification silently fall. So a write to a
 * path with a floor first requires the actor to be CURRENTLY cleared for it —
 * refused as a recorded `permission_denied`, before any effect — and then
 * binds the new bytes to at least the floor.
 *
 * Every other store, and a format-1 directory, has no floor: behaviour there
 * is exactly what it was.
 */

import type { LabelSet, Permission } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import { isVisible } from "../host/policy.js";
import type { ProjectRuntime } from "./runtime.js";

/**
 * The floor a write of `path` must keep, after requiring the acting principal
 * to hold `permission` with clearance for it now.
 *
 * @throws PortableRefusal `permission_denied` when the actor is not cleared for the floor.
 */
export async function clearedWriteFloor(runtime: ProjectRuntime, path: string, permission: Permission): Promise<LabelSet> {
  const floor = (await runtime.store.retainedLabels?.(path)) ?? [];
  if (floor.length > 0 && !(await isVisible(runtime.control, runtime.principal, permission, floor))) {
    throw new PortableRefusal("permission_denied", "the target keeps labels this actor is not cleared for");
  }
  return floor;
}
