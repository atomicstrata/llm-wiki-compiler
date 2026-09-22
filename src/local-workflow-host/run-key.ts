/**
 * @file src/local-workflow-host/run-key.ts
 * @description Execution-side run-key creation, preserving passive integrity exports.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { atomicWrite } from "../utils/markdown.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { resolveConfinedPrivateDir } from "../utils/private-dir.js";
import { RUN_KEY_BYTES, MAX_RUN_KEY_BYTES, runKeyPathFor, decodeKey } from "../workflow-history/integrity.js";
/** The realpath'd project root `atomicWrite`'s `confineRoot` must use. */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
}


/**
 * Load the per-project run HMAC key, CREATING it (32 random bytes, mode `0o600`) on
 * first use. The caller holds the project lock, so the create-if-absent is race-free
 * against other lock holders. The key is read no-follow + capped (a symlinked or
 * oversize key is rejected, then re-created), written through the confined
 * {@link atomicWrite} so a planted symlink at the key path is never followed.
 *
 * @param root - Absolute project root.
 * @returns The 32-byte secret key buffer.
 */
export async function loadOrCreateRunKey(root: string): Promise<Buffer> {
  const privateDir = await resolveConfinedPrivateDir(root);
  const keyPath = runKeyPathFor(privateDir);
  const read = await readCappedNoFollow(keyPath, MAX_RUN_KEY_BYTES);
  if (read.kind === "ok") {
    const existing = decodeKey(read.body);
    if (existing !== null) return existing;
  }
  const fresh = randomBytes(RUN_KEY_BYTES);
  await atomicWrite(keyPath, fresh.toString("base64"), {
    confineRoot: realRootOf(privateDir),
    durable: true,
    mode: 0o600,
  });
  return fresh;
}
