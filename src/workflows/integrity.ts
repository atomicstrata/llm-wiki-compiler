/**
 * @file src/workflows/integrity.ts
 * @description Per-record tamper-evidence for durable workflow run records.
 *
 * A run record AUTHORIZES live wiki writes and gate satisfaction, yet it is plain
 * editable JSON on disk. Shape validation alone cannot tell a legitimate record
 * from a hand-edited / synced-from-another-machine / restored-from-backup / forged
 * one — all of those parse with a perfectly valid shape. This module closes that
 * gap with a per-project HMAC: every write STAMPS `run.integrity` and every read
 * RECOMPUTES it and compares, so a record not produced by THIS project's secret key
 * fails closed.
 *
 * ## Key
 * The secret is 32 random bytes at `.llmwiki/workflows/.runkey` (mode `0o600`),
 * created on first use under the project lock the writer already holds and read
 * no-follow. It lives BESIDE `runs/`, never UNDER it, so it is never enumerated as
 * a run id. `.llmwiki/` is gitignored, so the key is never committed; it must also
 * NOT be synced/exported/backed-up (a copied key re-validates copied records).
 *
 * ## Canonicalization
 * The HMAC is over the RFC-8785 canonicalization of the run object with the
 * `integrity` field OMITTED, so key order / whitespace cannot change the MAC and
 * the stamp never feeds back into its own computation.
 *
 * ## Trust floor (residual)
 * A local actor who can READ `.runkey` can re-sign a forged record. The trust floor
 * is therefore local filesystem access to the project root — the same boundary that
 * already confines every other read/write here. This defeats the realistic remote
 * vectors (hand-edit, sync, restore, key-less forge); it is not a defense against an
 * attacker who already owns the root.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import canonicalize from "canonicalize";
import { atomicWrite } from "../utils/markdown.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
} from "../utils/private-dir.js";
import type { WorkflowRun } from "./types.js";

/** Bytes of secret-key entropy for the per-project run HMAC key. */
const RUN_KEY_BYTES = 32;

/** Inclusive byte ceiling for a `.runkey` read (a 32-byte key is far below this). */
const MAX_RUN_KEY_BYTES = 1024;

/** The `workflows` subdir (under `.llmwiki`) the key lives in, BESIDE `runs/`. */
const WORKFLOWS_SUBDIR = "workflows";

/** The key filename (a dot-leading, NON-`.json` name so `listRuns` never sees it). */
const RUN_KEY_FILENAME = ".runkey";

/** The realpath'd project root `atomicWrite`'s `confineRoot` must use. */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
}

/** The confined `.runkey` path under an already-confined private dir. */
function runKeyPathFor(privateDir: string): string {
  return path.join(privateDir, WORKFLOWS_SUBDIR, RUN_KEY_FILENAME);
}

/** Decode a base64 key body, returning the buffer only when it is the right length. */
function decodeKey(body: string): Buffer | null {
  const key = Buffer.from(body, "base64");
  return key.length === RUN_KEY_BYTES ? key : null;
}

/**
 * READ-ONLY load of the per-project run key, returning `null` when it is ABSENT (no
 * dir creation, no key minting). {@link readRun} uses this so a pure read never
 * writes state: a `null` key makes EVERY record fail integrity (fail closed — a run
 * whose key is gone cannot be vouched for). A symlinked/oversize/wrong-length key
 * reads `null` too.
 *
 * @param root - Absolute project root.
 * @returns The 32-byte key, or `null` when absent/untrusted.
 */
export async function loadRunKey(root: string): Promise<Buffer | null> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return null;
  }
  if (privateDir === null) return null;
  const read = await readCappedNoFollow(runKeyPathFor(privateDir), MAX_RUN_KEY_BYTES);
  return read.kind === "ok" ? decodeKey(read.body) : null;
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

/**
 * Compute the hex HMAC-SHA256 of `run` (with `integrity` OMITTED) under `key`. The
 * single place the MAC is computed, so the writer's stamp and the reader's recompute
 * can never disagree on what is signed.
 *
 * @param key - The per-project secret key.
 * @param run - The run to sign (its own `integrity` field is excluded).
 * @returns The lowercase-hex HMAC.
 */
export function runIntegrity(key: Buffer, run: WorkflowRun): string {
  const { integrity: _omit, ...content } = run;
  const canonical = canonicalize(content);
  if (canonical === undefined) {
    throw new Error("workflow run canonicalization produced no output");
  }
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

/**
 * Constant-time compare of the stored `integrity` against a freshly recomputed MAC.
 * A MISSING or wrong-length stored value (so the buffers differ in size) is rejected
 * WITHOUT a length-leaking early return path other than the size guard.
 *
 * @param stored - The `integrity` field read off disk (possibly `undefined`).
 * @param expected - The recomputed hex MAC.
 * @returns Whether the stored MAC is present and equal to `expected`.
 */
export function integrityMatches(stored: string | undefined, expected: string): boolean {
  if (typeof stored !== "string") return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
