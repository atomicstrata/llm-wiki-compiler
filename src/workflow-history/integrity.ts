/**
 * @file src/workflow-history/integrity.ts
 * @description Passive key reads and canonical run authentication. Key creation belongs to execution.
 * Inside one lock-held section (`utils/lock-held-reads.ts`) the key is read once:
 * the section's lock holder is its only possible writer, and it writes the key
 * only when no valid one could be read.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import canonicalize from "canonicalize";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { readOncePerLockHold } from "../utils/lock-held-reads.js";
import type { WorkflowRun } from "./types.js";
/** Bytes of secret-key entropy for the per-project run HMAC key. */
export const RUN_KEY_BYTES = 32;


/** Inclusive byte ceiling for a `.runkey` read (a 32-byte key is far below this). */
export const MAX_RUN_KEY_BYTES = 1024;


/** The `workflows` subdir (under `.llmwiki`) the key lives in, BESIDE `runs/`. */
const WORKFLOWS_SUBDIR = "workflows";


/** The key filename (a dot-leading, NON-`.json` name so `listRuns` never sees it). */
const RUN_KEY_FILENAME = ".runkey";


/** The confined `.runkey` path under an already-confined private dir. */
export function runKeyPathFor(privateDir: string): string {
  return path.join(privateDir, WORKFLOWS_SUBDIR, RUN_KEY_FILENAME);
}


/** Decode a base64 key body, returning the buffer only when it is the right length. */
export function decodeKey(body: string): Buffer | null {
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
  const key = await lockHeldRunKey(root, () => readRunKey(root), (read) => read !== null);
  return key === null ? null : Buffer.from(key);
}

/**
 * The run key through the lock-held section's one read, under the name every
 * run-key reader shares. Only a valid key (`keep`) serves later calls.
 */
export function lockHeldRunKey<T extends Buffer | null>(root: string, read: () => Promise<T>,
  keep: (key: T) => boolean = () => true): Promise<T> {
  return readOncePerLockHold("run-key", root, read, keep);
}

/** {@link loadRunKey}'s read: the confined, no-follow, capped key leaf, or `null`. */
async function readRunKey(root: string): Promise<Buffer | null> {
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
 * Compute the hex HMAC-SHA256 of `run` (with `integrity` OMITTED) under `key`. The
 * single place the MAC is computed, so the writer's stamp and the reader's recompute
 * can never disagree on what is signed.
 *
 * @param key - The per-project secret key.
 * @param run - The run to sign (its own `integrity` field is excluded).
 * @returns The lowercase-hex HMAC.
 */
export function runIntegrity(key: Buffer, run: WorkflowRun): string {
  return macOf(key, canonicalRunContent(run));
}


/**
 * The canonical text of `run` with `integrity` OMITTED: the exact preimage the
 * writer signs and the reader recomputes over.
 *
 * @param run - The run whose content is canonicalized (its own `integrity` field is excluded).
 * @returns The canonical JSON text.
 */
export function canonicalRunContent(run: WorkflowRun): string {
  const { integrity: _omit, ...content } = run;
  const canonical = canonicalize(content);
  if (canonical === undefined) {
    throw new Error("workflow run canonicalization produced no output");
  }
  return canonical;
}


/** The hex HMAC-SHA256 of canonical content text, read as UTF-8, under `key`. */
function macOf(key: Buffer, canonical: string): string {
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}


/**
 * A store's integrity computation: canonical content text in, lowercase-hex MAC
 * out, synchronously. A cryptographic MECHANISM and not a grant: it parses no
 * run, checks no schema and decides nothing.
 */
export type RunIntegrityComputation = (canonical: string) => string;


/**
 * The computation for one key. The key stays inside the returned function, so a
 * reader given the computation never holds the key.
 *
 * @param key - The per-project secret key.
 * @returns The computation {@link runIntegrity} applies to {@link canonicalRunContent}.
 */
export function runIntegrityComputation(key: Buffer): RunIntegrityComputation {
  return (canonical) => macOf(key, canonical);
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
