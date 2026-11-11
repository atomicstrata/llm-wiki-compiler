/**
 * @file src/portable/host/local-registry.ts
 * @description Where local host control state lives, and the read-only lookup
 * of whether a project root is registered.
 *
 * Control state is in a per-user directory OUTSIDE every project (D21), keyed
 * by a project's canonical root. A copied or moved project is a different
 * canonical root: it has no mapping, so it is unregistered and inherits no
 * identity, grant or approval.
 *
 * This module only computes paths and reads. It creates nothing and imports
 * nothing heavy, because the legacy mutation gate calls it on its hot path.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveLlmwikiOperatorRoots } from "../../operator-state/paths.js";

/** The per-user directory holding local host control state. */
export function localControlRoot(): string {
  return path.join(resolveLlmwikiOperatorRoots().configRoot, "host-control");
}

/** File holding the persisted host identity. */
export function hostIdentityFile(controlRoot: string): string {
  return path.join(controlRoot, "host.json");
}

/** File holding one project's control record. */
export function projectRecordFile(controlRoot: string, projectId: string): string {
  return path.join(controlRoot, "projects", `${projectId}.json`);
}

/** File mapping one canonical root to its host-issued project id. */
export function rootMappingFile(controlRoot: string, canonicalRoot: string): string {
  const key = createHash("sha256").update(canonicalRoot).digest("hex");
  return path.join(controlRoot, "roots", `${key}.json`);
}

/** Parse a JSON file, or `null` when it does not exist. */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return (await Bun.file(file).json()) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The project id registered for `root`, or `null`. The mapping must name this
 * exact canonical root, so a control file copied between machines binds nothing.
 */
export async function registeredProjectId(root: string, controlRoot = localControlRoot()): Promise<string | null> {
  const canonical = await realpath(root).catch(() => null);
  if (canonical === null) return null;
  const mapping = await readJsonFile<{ projectId: string; canonicalRoot: string }>(
    rootMappingFile(controlRoot, canonical),
  );
  return mapping !== null && mapping.canonicalRoot === canonical ? mapping.projectId : null;
}
