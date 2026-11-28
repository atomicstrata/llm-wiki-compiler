/**
 * @file src/storage/disk-local-records.ts
 * @description The local-directory implementation of {@link LegacyLocalRecords}.
 *
 * Each method makes the call the record's module made inline before the
 * binding existed, on the same absolute path, and lets that call's own error
 * through untouched:
 *
 *  - the read opens with `O_RDONLY | O_NOFOLLOW` through the shared hardened
 *    opener, so a symlinked leaf fails the open instead of being read THROUGH
 *    to out-of-tree bytes, and a FIFO or other special file is refused rather
 *    than blocking;
 *  - the write is the shared hardened {@link atomicWrite} (random exclusive
 *    temp, then rename) confined to the project root, so it inherits the same
 *    leaf-symlink write-escape defences as every page write.
 *
 * `.llmwiki/state.json` alone is routed to the segmented compile state on a
 * project where that store is the authority (`../cstate/records.ts`).
 */

import { constants as fsConstants, existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { openFileNoFollow } from "../utils/no-follow-open.js";
import { routedStateRecords } from "../cstate/records.js";
import type { LegacyLocalRecords } from "./legacy-local-records.js";

/** Read one file through a no-follow, regular-file-only handle; any open or read error propagates. */
async function readDiskTextNoFollow(filePath: string): Promise<string> {
  const handle = await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * The persisted records of an ordinary local project rooted at `root`.
 *
 * @param root - Project root directory, as the caller holds it (not canonicalized here).
 * @returns The binding every root-based record reader and writer is built from.
 */
export function diskLocalRecords(root: string): LegacyLocalRecords {
  const locate = (relPath: string): string => path.join(root, relPath);
  // On a project whose segmented compile state is the authority, state.json reaches that store.
  return routedStateRecords(root, {
    exists: async (relPath) => existsSync(locate(relPath)),
    readTextNoFollow: (relPath) => readDiskTextNoFollow(locate(relPath)),
    copy: (fromRelPath, toRelPath) => copyFile(locate(fromRelPath), locate(toRelPath)),
    writeAtomic: (relPath, text) => atomicWrite(locate(relPath), text, { confineRoot: root }),
    locate,
  });
}
