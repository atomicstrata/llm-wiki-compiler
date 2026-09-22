/**
 * @file src/local-workflow-host/entity-digest.ts
 * @description Existing confined entity postimage observation used by lifecycle
 * recovery. The engine receives a digest, not a writable or readable file handle.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveConfinedEntityPage } from "../profile/lifecycle-read.js";
import type { EntityTypeDef } from "../profile/types.js";

/** Resolve the same confined page and hash its current bytes, or report absence. */
export async function readLocalWorkflowEntityDigest(root: string, def: EntityTypeDef, slug: string): Promise<string | null> {
  const file = await resolveConfinedEntityPage(root, def, slug);
  if (file === null) return null;
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}
