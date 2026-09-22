/**
 * @file src/preparations/lifecycle-fs/observation-problems.ts
 * @description Stable, path-sanitized low-level lifecycle observation
 * problems shared by root entry and recursive storage capture.
 */

import path from "node:path";
import type {
  LifecycleObservationProblem,
  LifecycleUnitObservation,
  PreparationLifecycleNamespaceV1,
} from "./types.js";

/** Convert a path to a stable project-relative slash-separated value. */
export function lifecycleRelativePath(root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative === "" ? "." : relative;
}

/** Construct one stable problem without exposing an external absolute path. */
export function lifecycleObservationProblem(
  namespace: PreparationLifecycleNamespaceV1,
  code: LifecycleObservationProblem["code"],
  registry: "quarantine" | "prune",
  file: string,
  detail: string,
  unitId?: string,
): LifecycleObservationProblem {
  return {
    code,
    registry,
    ...(unitId === undefined ? {} : { unitId }),
    path: lifecycleRelativePath(namespace.root.realPath, file),
    detail,
  };
}

/** Retain one unavailable unit's identity rather than silently dropping it. */
export function unavailableLifecycleUnit(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
  unitId: string,
  file: string,
  detail: string,
  code: LifecycleObservationProblem["code"] = "unit-unavailable",
): LifecycleUnitObservation {
  return {
    registry,
    unitId,
    unitRoot: file,
    problem: lifecycleObservationProblem(
      namespace, code, registry, file, detail, unitId,
    ),
  };
}
