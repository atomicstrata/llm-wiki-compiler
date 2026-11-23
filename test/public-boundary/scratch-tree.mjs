/**
 * @file test/public-boundary/scratch-tree.mjs
 * @description The scratch source tree the public-boundary witnesses shared by copy: one `mkdtemp` root
 * per case, removed after it, and a writer of fixture modules into it. Plain JavaScript, like the
 * witnesses that import it. Hooks go through the storage-profile hooks, as before.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";

/**
 * Register, for the calling suite, a fresh scratch root per case, removed afterwards.
 * @param {string} prefix - The `mkdtemp` prefix under the OS temporary directory.
 * @param {(root: string) => void} onCreate - Receives each new root before the case runs.
 */
export function scratchTreePerCase(prefix, onCreate) {
  let root = "";
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), prefix)); onCreate(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
}

/** Write fixture modules under `root`: `{ "src/a.ts": "…" }`, creating their directories. */
export function writeTree(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}
