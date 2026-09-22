/**
 * @file src/capability-providers/runtime/evidence-store.ts
 * @description Host-owned accepted-evidence store (F1). Custody hashes every
 * accepted output, then copies its exact bytes here so the artifact survives
 * backend termination and a downstream consumer (Spec 2) can read it after the
 * provider process is gone. The store is content-addressed by the host-computed
 * digest and written create-only with the same hardened O_CREAT|O_EXCL|O_WRONLY
 * + fsync primitive the broker-response region uses; a repeat of identical bytes
 * is idempotent rather than an error. The directory is host-only (never mounted
 * into the sandbox) and is NOT disposed with the invocation scratch, because the
 * retained bytes are the durable output the caller owns.
 *
 * The directory is provisioned lazily on the first retain — never eagerly — so
 * every filesystem fault (realpath/mkdir/open/write/sync) happens inside the
 * custodian's fail-closed seam and becomes a closed rejected custody outcome
 * rather than a raw rejected promise (P2). `discard` rolls back a pass's
 * evidence when custody does not accept (P4).
 *
 * DURABILITY CONTRACT (P6): the store roots under `hostParentDir`, which today
 * is the invocation's `launchParentDir` — the same parent that holds the scratch
 * disposed at the end of the invocation. The evidence subtree is deliberately
 * NOT registered for disposal, but the caller MUST NOT remove `launchParentDir`
 * wholesale until the accepted evidence has been consumed. A dedicated
 * host-owned evidence root outside the invocation scratch is the clean seam for
 * the Spec 2 / Task 8-9 integration when that consumer lifecycle is defined.
 */
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { Sha256Digest } from "../types.js";
import type { EvidenceRefV1 } from "./result-admission.js";

const EVIDENCE_DIRECTORY = "accepted-evidence";
const DIGEST_PREFIX = "sha256:";

/** Retain and roll back accepted output bytes in the host-owned evidence store. */
export interface EvidenceStoreV1 {
  retain(bytes: Buffer, digest: Sha256Digest): Promise<EvidenceRefV1>;
  discard(refs: readonly EvidenceRefV1[]): Promise<void>;
  dispose(): Promise<void>;
}

/** Build the host-only accepted-evidence store; the directory is provisioned lazily. */
export function createEvidenceStore(hostParentDir: string): EvidenceStoreV1 {
  let rootOnce: Promise<string> | undefined;
  const ensureRoot = () => (rootOnce ??= provisionRoot(hostParentDir));
  return Object.freeze({
    retain: async (bytes: Buffer, digest: Sha256Digest) => retain(await ensureRoot(), bytes, digest),
    discard,
    dispose: async () => { if (rootOnce) await rootOnce.then((root) => rm(root, { recursive: true, force: true })).catch(() => {}); },
  });
}

/** Resolve and create the host-only evidence directory once, on first retain. */
async function provisionRoot(hostParentDir: string): Promise<string> {
  const parent = await realpath(hostParentDir);
  const root = path.join(parent, EVIDENCE_DIRECTORY);
  await mkdir(root, { mode: 0o700 });
  return root;
}

/** Copy one accepted output's bytes into content-addressed host evidence. */
async function retain(root: string, bytes: Buffer, digest: Sha256Digest): Promise<EvidenceRefV1> {
  const leaf = path.join(root, digest.slice(DIGEST_PREFIX.length));
  try {
    const handle = await open(leaf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return Object.freeze({ evidencePath: leaf, digest, byteCount: bytes.byteLength });
}

/** Remove evidence written during a custody pass that did not accept (P4). */
async function discard(refs: readonly EvidenceRefV1[]): Promise<void> {
  for (const ref of refs) await rm(ref.evidencePath, { force: true }).catch(() => {});
}
