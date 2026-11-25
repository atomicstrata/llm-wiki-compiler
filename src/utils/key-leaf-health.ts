/**
 * @file src/utils/key-leaf-health.ts
 * @description Health checks shared by every durable key leaf (the operation
 * and preparation key epochs, and the lifecycle key observation). A key leaf is
 * healthy only when it is mode 0600, owned by the current user, and linked
 * exactly once, or exactly twice through one named protocol-owned companion
 * alias left behind by a durable no-replace write. Recovery of a synced
 * ready-only crash key reuses its bytes; incomplete scratch bytes are disposable.
 * The durable no-replace publication of a key leaf is shared here too: it is the
 * MECHANISM under both epochs' create-or-refuse bodies, answering only whether it
 * created the leaf or found one there.
 */

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "./atomic-write.js";
import type { ConfirmedLeafOpen } from "./confined-read.js";

/** The read outcomes every key epoch distinguishes before recovery. */
type EpochKeyRecoveryRead =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "ok"; key: Buffer };

/** Enforce mode 0600 and current ownership on POSIX hosts that expose uid. */
export function healthyKeyMetadata(mode: number, uid: number): boolean {
  if (process.platform !== "win32" && (mode & 0o777) !== 0o600) return false;
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/** Accept one stable link, or exactly one named protocol-owned companion alias. */
export async function healthyKeyLinks(opened: ConfirmedLeafOpen, reservedAlias: string | undefined): Promise<boolean> {
  if (opened.nlink === 1) return true;
  if (opened.nlink !== 2 || reservedAlias === undefined) return false;
  const alias = await lstat(reservedAlias).catch(() => null);
  return alias !== null && alias.isFile() && !alias.isSymbolicLink()
    && alias.dev === opened.dev && alias.ino === opened.ino;
}

/** Reuse a synced ready-only crash key; an absent one is minted fresh. */
export function recoveredEpochKey(ready: EpochKeyRecoveryRead, byteCount: number, subject: string): Buffer {
  if (ready.status === "unavailable") throw new Error(`${subject} key recovery is unavailable`);
  return ready.status === "ok" ? ready.key : randomBytes(byteCount);
}

/**
 * Durably publish one key leaf's base64 text without replacing a leaf already
 * there, confined to `root` with its exact parent and mode 0600. `collision` when
 * a leaf owns the name; any other fault THROWS.
 */
export async function publishKeyLeafNoReplace(root: string, file: string, key: Buffer): Promise<"created" | "collision"> {
  try {
    await atomicWriteNoReplaceDurable(file, key.toString("base64"), { confineRoot: root, exactParent: true, mode: 0o600 });
    return "created";
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) return "collision";
    throw error;
  }
}
