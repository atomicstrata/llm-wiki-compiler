/**
 * @file src/profile/templates/publish/workspace-paths.ts
 * @description The fixed workspace layout. Every publisher write is confined to `root`.
 */
import path from "node:path";
import type { LockPaths } from "../../../utils/exclusive-lock.js";

/** Resolved workspace leaves beneath one operator-chosen directory. */
export interface WorkspacePaths extends LockPaths {
  root: string;
  manifestFile: string;
  lockFile: string;
  keysDir: string;
}

/** Resolve the fixed workspace layout beneath one operator-chosen directory. */
export function resolveWorkspacePaths(directory: string): WorkspacePaths {
  const root = path.resolve(directory);
  return {
    root,
    manifestFile: path.join(root, "workspace.json"),
    lockFile: path.join(root, "workspace.lock"),
    keysDir: path.join(root, "keys"),
  };
}
