/**
 * @file src/local-workflow-host/run-key.ts
 * @description Execution-side run-key creation, preserving passive integrity exports.
 *
 * ONE BODY: {@link loadOrCreateRunKeyWith} decides "an existing key that decodes is
 * reused, anything else mints 32 fresh random bytes" over {@link RunKeyStore}. The
 * root form passes {@link diskRunKeyStore}: ONE confined private-dir resolution,
 * then the no-follow capped read and the confined durable 0600 write of that one
 * key path, exactly as before. Inside one lock-held section the key is read or
 * minted once and shared with that section's passive `loadRunKey` (workflow-history/integrity).
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { atomicWrite } from "../utils/markdown.js";
import { readCappedNoFollow, type CappedLeafRead } from "../utils/confined-read.js";
import { resolveConfinedPrivateDir } from "../utils/private-dir.js";
import {
  RUN_KEY_BYTES, MAX_RUN_KEY_BYTES, runKeyPathFor, decodeKey, lockHeldRunKey,
} from "../workflow-history/integrity.js";
/** The realpath'd project root `atomicWrite`'s `confineRoot` must use. */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
}


/** The run key's one leaf, resolved once: its capped read and its replacement. */
export interface RunKeyLeaf {
  /** The key leaf's text within `maxBytes`, no-follow: `ok`, `absent` or `unavailable`. */
  read(maxBytes: number): Promise<CappedLeafRead>;
  /** Replace the key leaf with `text`, durably and owner-private. */
  replace(text: string): Promise<void>;
}

/** What the run-key load asks of the project. No member takes a project root. */
export interface RunKeyStore {
  /** Resolve the confined key location once; rejects on a confinement fault. */
  openKey(): Promise<RunKeyLeaf>;
}

/** LOCAL DISK: the confined private dir resolved when asked, then its one key path. In no package index. */
function diskRunKeyStore(root: string): RunKeyStore {
  return {
    openKey: async () => {
      const privateDir = await resolveConfinedPrivateDir(root);
      const keyPath = runKeyPathFor(privateDir);
      return {
        read: (maxBytes) => readCappedNoFollow(keyPath, maxBytes),
        replace: (text) => atomicWrite(keyPath, text, { confineRoot: realRootOf(privateDir), durable: true, mode: 0o600 }),
      };
    },
  };
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
  return Buffer.from(await lockHeldRunKey(root, () => loadOrCreateRunKeyWith(diskRunKeyStore(root))));
}

/** {@link loadOrCreateRunKey} over {@link RunKeyStore}: THE ONE BODY. An existing key that does not decode is replaced, as before. */
export async function loadOrCreateRunKeyWith(store: RunKeyStore): Promise<Buffer> {
  const leaf = await store.openKey();
  const read = await leaf.read(MAX_RUN_KEY_BYTES);
  if (read.kind === "ok") {
    const existing = decodeKey(read.body);
    if (existing !== null) return existing;
  }
  const fresh = randomBytes(RUN_KEY_BYTES);
  await leaf.replace(fresh.toString("base64"));
  return fresh;
}
