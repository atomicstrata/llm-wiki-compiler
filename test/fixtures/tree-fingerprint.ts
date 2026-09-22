/**
 * @file test/fixtures/tree-fingerprint.ts
 * @description A write-free proof helper shared by the no-mutation surfaces:
 * fingerprint a directory tree by per-file size+length, then report which
 * paths differ. An empty fingerprint is a precondition to check, not a pass.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Every file under `root` mapped to the sha256 of its bytes. */
export async function fingerprintTree(root: string): Promise<Map<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const rows = await Promise.all(files.map(async (entry) => {
    const full = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(full).catch(() => Buffer.alloc(0));
    return [path.relative(root, full), createHash("sha256").update(bytes).digest("hex")] as const;
  }));
  return new Map(rows);
}

/** The relative paths whose content or size differs between two fingerprints. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}
